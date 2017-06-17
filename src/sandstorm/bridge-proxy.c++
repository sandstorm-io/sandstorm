// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2017 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "bridge-proxy.h"
#include <map>
#include <sandstorm/api-session.capnp.h>
#include <sandstorm/bridge-proxy.capnp.h>
#include <capnp/compat/json.h>
#include <kj/debug.h>
#include <kj/encoding.h>
#include "util.h"

namespace sandstorm {
namespace {

kj::Maybe<kj::StringPtr> removePrefix(kj::StringPtr prefix, kj::StringPtr str) {
  if (str.startsWith(prefix)) {
    return str.slice(prefix.size());
  } else {
    return nullptr;
  }
}

HttpStatusDescriptor::Reader getHttpStatusAnnotation(capnp::EnumSchema::Enumerant enumerant) {
  for (auto annotation: enumerant.getProto().getAnnotations()) {
    if (annotation.getId() == HTTP_STATUS_ANNOTATION_ID) {
      return annotation.getValue().getStruct().getAs<HttpStatusDescriptor>();
    }
  }
  KJ_FAIL_ASSERT("Missing httpStatus annotation on status code enumerant.",
                 enumerant.getProto().getName());
}

class BridgeProxy final: public kj::HttpService {
public:
  BridgeProxy(SandstormApi<BridgeObjectId>::Client sandstormApi,
              SandstormHttpBridge::Client bridge,
              spk::BridgeConfig::Reader config,
              kj::HttpHeaderTable::Builder& requestHeaders)
      : sandstormApi(kj::mv(sandstormApi)),
        bridge(kj::mv(bridge)),
        config(config),
        hAccept(requestHeaders.add("Accept")),
        hAcceptEncoding(requestHeaders.add("Accept-Encoding")),
        hAuthorization(requestHeaders.add("Authorization")),
        hContentDisposition(requestHeaders.add("Content-Disposition")),
        hContentEncoding(requestHeaders.add("Content-Encoding")),
        hContentLanguage(requestHeaders.add("Content-Language")),
        hContentType(requestHeaders.add("Content-Type")),
        hETag(requestHeaders.add("ETag")),
        hIfMatch(requestHeaders.add("If-Match")),
        hIfNoneMatch(requestHeaders.add("If-None-Match")),
        headerTable(requestHeaders.getFutureTable()),
        successCodeTable(KJ_MAP(enumerant,
              capnp::Schema::from<WebSession::Response::SuccessCode>().getEnumerants()) {
          return getHttpStatusAnnotation(enumerant);
        }),
        errorCodeTable(KJ_MAP(enumerant,
              capnp::Schema::from<WebSession::Response::ClientErrorCode>().getEnumerants()) {
          return getHttpStatusAnnotation(enumerant);
        }),
        requestHeaderWhitelist(*WebSession::Context::HEADER_WHITELIST),
        responseHeaderWhitelist(*WebSession::Response::HEADER_WHITELIST) {
  }

  kj::Promise<void> request(
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, Response& response) override {
    KJ_IF_MAYBE(pathStr, removePrefix("http://http-bridge/", url)) {
      KJ_REQUIRE(pathStr->findFirst('?') == nullptr, "unrecognized query string", url);
      auto path = KJ_MAP(part, split(*pathStr, '/')) { return kj::heapString(part); };

      if (path.size() > 2 && path[0] == "session" && path[2] == "claim" &&
          method == kj::HttpMethod::POST) {
        // POST /session/<id>/claim -- do a claimRequest().

        auto context = ({
          auto req = bridge.getSessionContextRequest();
          req.setId(path[1]);
          req.send().getContext();
        });

        return requestBody.readAllText()
            .then([this,KJ_MVCAP(context)](kj::String body) mutable
                -> kj::Promise<capnp::Response<SandstormApi<BridgeObjectId>::SaveResults>> {
          capnp::MallocMessageBuilder builder(128);
          auto parsedRequest = builder.initRoot<ProxyClaimRequestRequest>();
          capnp::JsonCodec json;
          json.decode(body, parsedRequest);

          auto req = context.claimRequestRequest();
          req.setRequestToken(parsedRequest.getRequestToken());

          auto permissionDefs = config.getViewInfo().getPermissions();
          auto requiredPerms = KJ_MAP(name, parsedRequest.getRequiredPermissions())
                                       -> kj::StringPtr { return name; };

          auto permArray = req.initRequiredPermissions(permissionDefs.size());

          for (size_t i: kj::indices(permissionDefs)) {
            auto defName = permissionDefs[i].getName();

            for (auto& reqName: requiredPerms) {
              if (reqName == defName) {
                permArray.set(i, true);
              }
            }
          }

          auto req2 = sandstormApi.saveRequest();
          req2.setCap(req.send().getCap());
          req2.setLabel(parsedRequest.getLabel());
          return req2.send();
        }).then([this,&response]
            (capnp::Response<SandstormApi<BridgeObjectId>::SaveResults>&& claim) {
          capnp::MallocMessageBuilder builder(64);
          auto root = builder.initRoot<ProxyClaimRequestResponse>();
          root.setCap(kj::encodeBase64(claim.getToken(), false));

          capnp::JsonCodec json;
          kj::String text = json.encode(root);

          kj::HttpHeaders headers(headerTable);
          headers.set(hContentType, "application/json; charset=UTF-8");
          auto stream = response.send(200, "OK", headers, text.size());
          auto promise = stream->write(text.begin(), text.size());
          return promise.attach(kj::mv(stream), kj::mv(text));
        });
      }
    }

    KJ_IF_MAYBE(auth, headers.get(hAuthorization)) {
      if (auth->startsWith("bearer ") || auth->startsWith("Bearer ")) {
        auto token = auth->slice(strlen("bearer "));
        auto session = getHttpSession(token);
        return dispatchToSession(kj::mv(session), method, url, headers, requestBody, response);
      }
    }

    return sendError(response, 404, "Not Found");
  }

  // TODO(someday): WebSocket (when KJ HTTP supports it).

private:
  SandstormApi<BridgeObjectId>::Client sandstormApi;
  SandstormHttpBridge::Client bridge;
  spk::BridgeConfig::Reader config;

  kj::HttpHeaderId hAccept;
  kj::HttpHeaderId hAcceptEncoding;
  kj::HttpHeaderId hAuthorization;
  kj::HttpHeaderId hContentDisposition;
  kj::HttpHeaderId hContentEncoding;
  kj::HttpHeaderId hContentLanguage;
  kj::HttpHeaderId hContentType;
  kj::HttpHeaderId hETag;
  kj::HttpHeaderId hIfMatch;
  kj::HttpHeaderId hIfNoneMatch;
  kj::HttpHeaderTable& headerTable;

  struct TokenInfo {
    TokenInfo(const TokenInfo&) = delete;
    TokenInfo(TokenInfo&&) = default;

    kj::String key;
    ApiSession::Client cap;
  };

  std::map<kj::StringPtr, TokenInfo> tokenMap;

  kj::Array<HttpStatusDescriptor::Reader> successCodeTable;
  kj::Array<HttpStatusDescriptor::Reader> errorCodeTable;
  HeaderWhitelist requestHeaderWhitelist;
  HeaderWhitelist responseHeaderWhitelist;

  template <typename T>
  inline HttpStatusDescriptor::Reader lookupStatus(
      kj::ArrayPtr<HttpStatusDescriptor::Reader> table,
      T codeEnum) {
    if (static_cast<uint>(codeEnum) < table.size()) {
      return table[static_cast<uint>(codeEnum)];
    } else {
      // The first item in each table happens to be a reasonable generic code for that table.
      return table.front();
    }
  }

  kj::Promise<void> sendError(kj::HttpService::Response& response,
                              uint statusCode, kj::StringPtr statusText) {
    kj::HttpHeaders headers(headerTable);
    return sendError(response, statusCode, statusText, headers);
  }

  kj::Promise<void> sendError(kj::HttpService::Response& response,
                              uint statusCode, kj::StringPtr statusText,
                              kj::HttpHeaders& headers) {
    auto stream = response.send(statusCode, statusText, headers, statusText.size());
    auto promise = stream->write(statusText.begin(), statusText.size());
    return promise.attach(kj::mv(stream));
  }

  ApiSession::Client getHttpSession(kj::StringPtr token) {
    auto iter = tokenMap.find(token);
    if (iter == tokenMap.end()) {
      // Use a CapRedirector to automatically reconnect after disconnects. Keep in mind that due
      // to refcounting, the CapRedirector could outlive the BridgeProxy. Luckily it doesn't need
      // to capture "this".
      auto cap = capnp::Capability::Client(
          kj::heap<CapRedirector>([sandstormApi=sandstormApi,token=kj::str(token)]() mutable {
        auto req = sandstormApi.restoreRequest();
        req.setToken(kj::decodeBase64(token));
        return req.send().getCap();
      })).castAs<ApiSession>();

      TokenInfo info { kj::heapString(token), cap };
      kj::StringPtr key = info.key;
      tokenMap.insert(std::make_pair(key, kj::mv(info)));
      return kj::mv(cap);
    } else {
      return iter->second.cap;
    }
  }

  kj::Promise<void> dispatchToSession(ApiSession::Client session,
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, Response& response) {
    // TODO(cleanup): Factor this out into a reusable component that adapts
    //   HttpService -> WebSession. We could then consider moving the HTTP proxy code out of the
    //   Sandstorm shell, replacing it with this! Which would be amazing!

    kj::StringPtr path;

    KJ_IF_MAYBE(p, removePrefix("http://", url)) {
      path = *p;
    } else KJ_IF_MAYBE(p, removePrefix("https://", url)) {
      path = *p;
    } else {
      KJ_FAIL_REQUIRE("unknown protocol", url);
    }

    KJ_IF_MAYBE(i, path.findFirst('/')) {
      path = path.slice(*i + 1);
    } else {
      path = "";
    }

    if (url.startsWith("http://")) {
      url = url.slice(strlen("http://"));
    }

    static constexpr size_t MAX_NONSTREAMING_LENGTH = 65536;

    switch (method) {
      case kj::HttpMethod::GET:
      case kj::HttpMethod::HEAD: {
        auto req = session.getRequest();
        req.setPath(path);
        req.setIgnoreBody(method == kj::HttpMethod::HEAD);
        auto streamer = initContext(req.initContext(), headers);
        return handleResponse(req.send(), kj::mv(streamer), response);
      }

      case kj::HttpMethod::POST: {
        KJ_IF_MAYBE(length, requestBody.tryGetLength()) {
          if (*length < MAX_NONSTREAMING_LENGTH) {
            return requestBody.readAllBytes()
                .then([this,KJ_MVCAP(session),path,&headers,&response]
                      (kj::Array<byte>&& data) mutable {
              auto req = session.postRequest();
              req.setPath(path);
              auto content = req.initContent();
              content.setContent(data);
              initContent(content, headers);
              auto streamer = initContext(req.initContext(), headers);
              return handleResponse(req.send(), kj::mv(streamer), response);
            });
          }
        }

        // Fall back to streaming.
        auto req = session.postStreamingRequest();
        req.setPath(path);
        initContent(req, headers);
        auto streamer = initContext(req.initContext(), headers);
        return handleStreamingRequestResponse(
            req.send().getStream(), requestBody, kj::mv(streamer), response);
      }

      case kj::HttpMethod::PUT: {
        KJ_IF_MAYBE(length, requestBody.tryGetLength()) {
          if (*length < MAX_NONSTREAMING_LENGTH) {
            return requestBody.readAllBytes()
                .then([this,KJ_MVCAP(session),path,&headers,&response]
                      (kj::Array<byte>&& data) mutable {
              auto req = session.putRequest();
              req.setPath(path);
              auto content = req.initContent();
              content.setContent(data);
              initContent(content, headers);
              auto streamer = initContext(req.initContext(), headers);
              return handleResponse(req.send(), kj::mv(streamer), response);
            });
          }
        }

        // Fall back to streaming.
        auto req = session.putStreamingRequest();
        req.setPath(path);
        initContent(req, headers);
        auto streamer = initContext(req.initContext(), headers);
        return handleStreamingRequestResponse(
            req.send().getStream(), requestBody, kj::mv(streamer), response);
      }

      case kj::HttpMethod::DELETE: {
        auto req = session.deleteRequest();
        req.setPath(path);
        auto streamer = initContext(req.initContext(), headers);
        return handleResponse(req.send(), kj::mv(streamer), response);
      }

      case kj::HttpMethod::PATCH: {
        return requestBody.readAllBytes()
            .then([this,KJ_MVCAP(session),path,&headers,&response]
                  (kj::Array<byte>&& data) mutable {
          auto req = session.patchRequest();
          req.setPath(path);
          auto content = req.initContent();
          content.setContent(data);
          initContent(content, headers);
          auto streamer = initContext(req.initContext(), headers);
          return handleResponse(req.send(), kj::mv(streamer), response);
        });
      }

      // TODO(soon): WebDAV methods.

      default:
        return sendError(response, 501, "Not Implemented");
    }
  }

  struct ContextInitInfo {
    kj::Own<kj::PromiseFulfiller<ByteStream::Client>> streamer;
    bool hadIfNoneMatch = false;
  };

  ContextInitInfo initContext(
      WebSession::Context::Builder context, const kj::HttpHeaders& headers) {
    // We intentionally ignore cookies.

    bool hadIfNoneMatch = false;

    auto paf = kj::newPromiseAndFulfiller<ByteStream::Client>();
    context.setResponseStream(kj::mv(paf.promise));

    KJ_IF_MAYBE(accept, headers.get(hAccept)) {
      auto items = split(*accept, ',');
      auto list = context.initAccept(items.size());
      for (size_t i: kj::indices(items)) {
        auto item = items[i];
        auto builder = list[i];

        auto parts = split(item, ';');
        builder.setMimeType(trim(parts[0]));

        for (auto part: parts.asPtr().slice(1, parts.size())) {
          KJ_IF_MAYBE(name, splitFirst(part, '=')) {
            if (trim(*name) == "q") {
              builder.setQValue(trim(part).parseAs<float>());
            }
          }
        }
      }
    }

    KJ_IF_MAYBE(accept, headers.get(hAcceptEncoding)) {
      auto items = split(*accept, ',');
      auto list = context.initAcceptEncoding(items.size());
      for (size_t i: kj::indices(items)) {
        auto item = items[i];
        auto builder = list[i];

        auto parts = split(item, ';');
        builder.setContentCoding(trim(parts[0]));

        for (auto part: parts.asPtr().slice(1, parts.size())) {
          KJ_IF_MAYBE(name, splitFirst(part, '=')) {
            if (trim(*name) == "q") {
              builder.setQValue(trim(part).parseAs<float>());
            }
          }
        }
      }
    }

    KJ_IF_MAYBE(match, headers.get(hIfMatch)) {
      if (*match == "*") {
        context.getETagPrecondition().setExists();
      } else {
        context.getETagPrecondition().adoptMatchesOneOf(
            parseETagList(capnp::Orphanage::getForMessageContaining(context), *match));
      }
    } else KJ_IF_MAYBE(match, headers.get(hIfNoneMatch)) {
      hadIfNoneMatch = true;
      if (*match == "*") {
        context.getETagPrecondition().setDoesntExist();
      } else {
        context.getETagPrecondition().adoptMatchesNoneOf(
            parseETagList(capnp::Orphanage::getForMessageContaining(context), *match));
      }
    }

    kj::Vector<kj::Tuple<kj::StringPtr, kj::StringPtr>> whitelisted;
    headers.forEach([&](kj::StringPtr name, kj::StringPtr value) {
      if (requestHeaderWhitelist.matches(name)) {
        whitelisted.add(kj::tuple(name, value));
      }
    });
    if (whitelisted.size() > 0) {
      auto list = context.initAdditionalHeaders(whitelisted.size());
      for (size_t i: kj::indices(whitelisted)) {
        auto out = list[i];
        out.setName(kj::get<0>(whitelisted[i]));
        out.setValue(kj::get<1>(whitelisted[i]));
      }
    }

    return { kj::mv(paf.fulfiller), hadIfNoneMatch };
  }

  template <typename Builder>
  void initContent(Builder&& builder, const kj::HttpHeaders& headers) {
    KJ_IF_MAYBE(value, headers.get(hContentEncoding)) {
      builder.setEncoding(*value);
    }
    KJ_IF_MAYBE(value, headers.get(hContentType)) {
      builder.setMimeType(*value);
    }
  }

  capnp::Orphan<capnp::List<WebSession::ETag>> parseETagList(
      capnp::Orphanage orphanage, kj::StringPtr text,
      kj::Vector<kj::Tuple<kj::String, bool>> parsed = kj::Vector<kj::Tuple<kj::String, bool>>()) {
    parsed.add(parseETagInternal(text));
    if (text.size() > 0) {
      KJ_REQUIRE(text[0] == ',', "etag must be followed by comma", text);
      return parseETagList(orphanage, text.slice(1), kj::mv(parsed));
    } else {
      auto result = orphanage.newOrphan<capnp::List<WebSession::ETag>>(parsed.size());
      auto list = result.get();
      for (size_t i: kj::indices(parsed)) {
        auto etag = list[i];
        etag.setValue(kj::get<0>(parsed[i]));
        etag.setWeak(kj::get<1>(parsed[i]));
      }
      return result;
    }
  }

  kj::Tuple<kj::String, bool> parseETagInternal(kj::StringPtr& text) {
    const char* p = text.begin();

    while (*p == ' ') ++p;

    bool weak = false;
    if (p[0] == 'W' && p[1] == '/') {
      weak = true;
      p += 2;
    }

    while (*p == ' ') ++p;

    KJ_REQUIRE(*p == '\"', "invalid ETag; must be quoted", text);

    ++p;
    kj::Vector<char> chars;

    for (;;) {
      switch (*p) {
        case '\"':
          // done
          ++p;
          while (p[0] == ' ') ++p;
          text = text.slice(p - text.begin());
          chars.add('\0');
          return kj::tuple(kj::String(chars.releaseAsArray()), weak);
        case '\\':
          ++p;
          KJ_REQUIRE(*p != '\0', "invalid ETag escape sequence", text);
          chars.add(*p);
          break;
        case '\0':
          KJ_FAIL_ASSERT("invalid ETag missing end quote",text);
        default:
          chars.add(*p);
          break;
      }
      ++p;
    }
  }

  kj::Promise<void> handleStreamingRequestResponse(
      WebSession::RequestStream::Client reqStream,
      kj::AsyncInputStream& requestBody,
      ContextInitInfo&& contextInitInfo,
      kj::HttpService::Response& out) {
    auto promises = kj::heapArrayBuilder<kj::Promise<void>>(2);
    promises.add(pump(requestBody, reqStream));
    promises.add(handleResponse(reqStream.getResponseRequest().send(),
                                kj::mv(contextInitInfo), out));
    return kj::joinPromises(promises.finish());
  }

  kj::Promise<void> handleResponse(kj::Promise<capnp::Response<WebSession::Response>>&& promise,
                                   ContextInitInfo&& contextInitInfo,
                                   kj::HttpService::Response& out) {
    return promise.then([this,KJ_MVCAP(contextInitInfo),&out](
        capnp::Response<WebSession::Response>&& in) mutable -> kj::Promise<void> {
      // TODO(someday): cachePolicy (not supported in Sandstorm proper as of this writing)

      kj::HttpHeaders headers(headerTable);

      for (auto addlHeader: in.getAdditionalHeaders()) {
        auto name = addlHeader.getName();
        if (responseHeaderWhitelist.matches(name)) {
          headers.add(name, addlHeader.getValue());
        }
      }

      switch (in.which()) {
        case WebSession::Response::CONTENT: {
          auto content = in.getContent();

          auto status = lookupStatus(successCodeTable, content.getStatusCode());

          if (content.hasEncoding()) {
            headers.set(hContentEncoding, content.getEncoding());
          }
          if (content.hasLanguage()) {
            headers.set(hContentLanguage, content.getLanguage());
          }
          if (content.hasMimeType()) {
            headers.set(hContentType, content.getMimeType());
          }

          if (content.hasETag()) {
            setETag(headers, content.getETag());
          }

          auto disposition = content.getDisposition();
          switch (disposition.which()) {
            case WebSession::Response::Content::Disposition::NORMAL:
              break;
            case WebSession::Response::Content::Disposition::DOWNLOAD: {
              headers.set(hContentDisposition,
                  kj::str("attachment; filename=\"", escape(disposition.getDownload()), "\""));
              break;
            }
          }

          auto body = content.getBody();

          switch (body.which()) {
            case WebSession::Response::Content::Body::BYTES: {
              auto data = body.getBytes();
              auto stream = out.send(status.getId(), status.getTitle(), headers, data.size());
              auto promise = stream->write(data.begin(), data.size());
              return promise.attach(kj::mv(stream), kj::mv(in));
            }
            case WebSession::Response::Content::Body::STREAM: {
              auto handle = body.getStream();
              auto outStream = kj::heap<ByteStreamImpl>(
                  status, kj::mv(headers), kj::mv(in), out);
              auto promise = outStream->whenDone();
              contextInitInfo.streamer->fulfill(kj::mv(outStream));
              return promise.attach(kj::mv(handle));
            }
          }

          KJ_UNREACHABLE;
        }

        case WebSession::Response::NO_CONTENT: {
          auto noContent = in.getNoContent();

          if (noContent.hasETag()) {
            setETag(headers, noContent.getETag());
          }

          if (noContent.getShouldResetForm()) {
            out.send(205, "Reset Content", headers);
          } else {
            out.send(204, "No Content", headers);
          }
          return kj::READY_NOW;
        }

        case WebSession::Response::PRECONDITION_FAILED: {
          auto failed = in.getPreconditionFailed();

          if (contextInitInfo.hadIfNoneMatch) {
            if (failed.hasMatchingETag()) {
              setETag(headers, failed.getMatchingETag());
            }

            out.send(304, "Not Modified", headers);
            return kj::READY_NOW;
          } else {
            return sendError(out, 412, "Precondition Failed", headers);
          }
        }

        case WebSession::Response::REDIRECT: {
          auto redirect = in.getRedirect();

          uint code;
          kj::StringPtr name;
          if (redirect.getSwitchToGet()) {
            if (redirect.getIsPermanent()) {
              code = 301; name = "Moved Permanently";
            } else {
              code = 303; name = "See Other";
            }
          } else {
            if (redirect.getIsPermanent()) {
              code = 308; name = "Permanent Redirect";
            } else {
              code = 307; name = "Temporary Redirect";
            }
          }

          auto location = redirect.getLocation();
          headers.set(kj::HttpHeaderId::LOCATION, location);

          headers.set(kj::HttpHeaderId::CONTENT_TYPE, "text/plain; charset=UTF-8");
          auto body = kj::str(name, ": ", location);

          auto stream = out.send(code, name, headers, body.size());
          auto promise = stream->write(body.begin(), body.size());
          return promise.attach(kj::mv(stream), kj::mv(body));
        }

        case WebSession::Response::CLIENT_ERROR: {
          auto error = in.getClientError();

          auto status = lookupStatus(errorCodeTable, error.getStatusCode());

          return handleErrorBody(
              error, status.getId(), status.getTitle(), headers, kj::mv(in), out);
        }

        case WebSession::Response::SERVER_ERROR: {
          auto error = in.getServerError();

          return handleErrorBody(
              error, 500, "Internal Server Error", headers, kj::mv(in), out);
        }
      }

      KJ_UNREACHABLE;
    });
  }

  template <typename T>
  kj::Promise<void> handleErrorBody(T error, uint statusCode, kj::StringPtr statusText,
                                    kj::HttpHeaders& headers,
                                    capnp::Response<WebSession::Response>&& in,
                                    kj::HttpService::Response& out) {
    kj::ArrayPtr<const byte> data;
    if (error.hasNonHtmlBody()) {
      auto body = error.getNonHtmlBody();
      headers.set(kj::HttpHeaderId::CONTENT_TYPE, body.getMimeType());

      if (body.hasEncoding()) {
        headers.set(hContentEncoding, body.getEncoding());
      }
      if (body.hasLanguage()) {
        headers.set(hContentLanguage, body.getLanguage());
      }

      data = body.getData();
    } else if (error.hasDescriptionHtml()) {
      data = error.getDescriptionHtml().asBytes();
      headers.set(kj::HttpHeaderId::CONTENT_TYPE, "text/html; charset=UTF-8");
    }

    auto stream = out.send(statusCode, statusText, headers, data.size());
    auto promise = stream->write(data.begin(), data.size());
    return promise.attach(kj::mv(stream), kj::mv(in));
  }

  void setETag(kj::HttpHeaders& headers, WebSession::ETag::Reader etag) {
    if (etag.getWeak()) {
      headers.set(hETag, kj::str("W/\"", etag.getValue(), "\""));
    } else {
      headers.set(hETag, kj::str("\"", etag.getValue(), "\""));
    }
  }

  kj::String escape(kj::StringPtr value) {
    kj::Vector<char> chars(value.size());

    for (char c: value) {
      switch (c) {
        case '\\':
        case '\"':
          chars.add('\\');
          break;
        default:
          break;
      }
      chars.add(c);
    }

    return kj::String(chars.releaseAsArray());
  }

  class ByteStreamImpl: public ByteStream::Server {
  public:
    ByteStreamImpl(HttpStatusDescriptor::Reader status,
                   kj::HttpHeaders&& headers,
                   capnp::Response<WebSession::Response>&& inResponse,
                   kj::HttpService::Response& response) {
      state.init<NotStarted>(NotStarted { status, kj::mv(headers), kj::mv(inResponse), response });
    }

    kj::Promise<void> whenDone() {
      auto paf = kj::newPromiseAndFulfiller<void>();
      doneFulfiller = kj::mv(paf.fulfiller);
      return kj::mv(paf.promise);
    }

    kj::Promise<void> write(WriteContext context) override {
      auto& stream = ensureStarted(nullptr);
      auto data = context.getParams().getData();
      return stream.write(data.begin(), data.size());
    }

    kj::Promise<void> done(DoneContext context) override {
      state.init<Done>();
      doneFulfiller->fulfill();
      return kj::READY_NOW;
    }

    kj::Promise<void> expectSize(ExpectSizeContext context) override {
      ensureStarted(context.getParams().getSize());
      return kj::READY_NOW;
    }

  private:
    struct NotStarted {
      HttpStatusDescriptor::Reader status;
      kj::HttpHeaders headers;
      capnp::Response<WebSession::Response> inResponse;
      kj::HttpService::Response& response;
    };

    struct Started {
      kj::Own<kj::AsyncOutputStream> output;
    };

    struct Done {};

    kj::OneOf<NotStarted, Started, Done> state;
    kj::Own<kj::PromiseFulfiller<void>> doneFulfiller;

    kj::AsyncOutputStream& ensureStarted(kj::Maybe<uint64_t> size) {
      if (state.is<NotStarted>()) {
        auto& ns = state.get<NotStarted>();
        auto stream = ns.response.send(ns.status.getId(), ns.status.getTitle(), ns.headers, size);
        kj::AsyncOutputStream& ref = *stream;
        state.init<Started>(Started { kj::mv(stream) });
        return ref;
      } else {
        KJ_REQUIRE(!state.is<Done>(), "already called done()");
        return *state.get<Started>().output;
      }
    }
  };
};

}  // namespace

kj::Own<kj::HttpService> newBridgeProxy(
    SandstormApi<BridgeObjectId>::Client sandstormApi,
    SandstormHttpBridge::Client bridge,
    spk::BridgeConfig::Reader config,
    kj::HttpHeaderTable::Builder& requestHeaders) {
  return kj::heap<BridgeProxy>(kj::mv(sandstormApi), kj::mv(bridge), config, requestHeaders);
}

} // namespace sandstorm
