// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

// This program is useful for including in Sandstorm application packages where
// the application itself is a legacy HTTP web server that does not understand
// how to speak the Cap'n Proto interface directly.  This program will start up
// that server and then redirect incoming requests to it over standard HTTP on
// the loopback network interface.

#include <kj/main.h>
#include <kj/debug.h>
#include <kj/async-io.h>
#include <kj/async-unix.h>
#include <kj/io.h>
#include <kj/encoding.h>
#include <capnp/membrane.h>
#include <capnp/rpc-twoparty.h>
#include <capnp/rpc.capnp.h>
#include <capnp/schema.h>
#include <capnp/serialize.h>
#include <capnp/compat/json.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <map>
#include <unordered_map>
#include <time.h>
#include <stdlib.h>
#include <signal.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <fcntl.h>
#include <stdio.h>

#include <sandstorm/util.capnp.h>
#include <sandstorm/grain.capnp.h>
#include <sandstorm/api-session.capnp.h>
#include <sandstorm/web-session.capnp.h>
#include <sandstorm/email.capnp.h>
#include <sandstorm/sandstorm-http-bridge.capnp.h>
#include <sandstorm/sandstorm-http-bridge-internal.capnp.h>
#include <sandstorm/hack-session.capnp.h>
#include <sandstorm/package.capnp.h>
#include <joyent-http/http_parser.h>

#include "version.h"
#include "util.h"
#include "bridge-proxy.h"

namespace sandstorm {

kj::Array<byte> toBytes(kj::StringPtr text, kj::ArrayPtr<const byte> data = nullptr) {
  auto result = kj::heapArray<byte>(text.size() + data.size());
  memcpy(result.begin(), text.begin(), text.size());
  memcpy(result.begin() + text.size(), data.begin(), data.size());
  return result;
}

kj::String textIdentityId(capnp::Data::Reader id) {
  // We truncate to 128 bits to be a little more wieldy. Still 32 chars, though.
  KJ_ASSERT(id.size() == 32, "Identity ID not a SHA-256?");
  return kj::encodeHex(id.slice(0, kj::min(id.size(), 16)));
}

struct HttpStatusInfo {
  WebSession::Response::Which type;

  union {
    WebSession::Response::SuccessCode successCode;
    struct { bool shouldResetForm; } noContent;
    struct { bool isPermanent; bool switchToGet; } redirect;
    WebSession::Response::ClientErrorCode clientErrorCode;
  };
};

HttpStatusInfo noContentInfo(bool shouldResetForm) {
  HttpStatusInfo result;
  result.type = WebSession::Response::NO_CONTENT;
  result.noContent.shouldResetForm = shouldResetForm;
  return result;
}

HttpStatusInfo redirectInfo(bool isPermanent, bool switchToGet) {
  HttpStatusInfo result;
  result.type = WebSession::Response::REDIRECT;
  result.redirect.isPermanent = isPermanent;
  result.redirect.switchToGet = switchToGet;
  return result;
}

HttpStatusInfo preconditionFailedInfo() {
  HttpStatusInfo result;
  result.type = WebSession::Response::PRECONDITION_FAILED;
  return result;
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

std::unordered_map<uint, HttpStatusInfo> makeStatusCodes() {
  std::unordered_map<uint, HttpStatusInfo> result;
  for (capnp::EnumSchema::Enumerant enumerant:
       capnp::Schema::from<WebSession::Response::SuccessCode>().getEnumerants()) {
    auto& info = result[getHttpStatusAnnotation(enumerant).getId()];
    info.type = WebSession::Response::CONTENT;
    info.successCode = static_cast<WebSession::Response::SuccessCode>(enumerant.getOrdinal());
  }
  for (capnp::EnumSchema::Enumerant enumerant:
       capnp::Schema::from<WebSession::Response::ClientErrorCode>().getEnumerants()) {
    auto& info = result[getHttpStatusAnnotation(enumerant).getId()];
    info.type = WebSession::Response::CLIENT_ERROR;
    info.clientErrorCode =
        static_cast<WebSession::Response::ClientErrorCode>(enumerant.getOrdinal());
  }

  result[204] = noContentInfo(false);
  result[205] = noContentInfo(true);

  result[304] = preconditionFailedInfo();

  result[301] = redirectInfo(true, true);
  result[302] = redirectInfo(false, true);
  result[303] = redirectInfo(false, true);
  result[307] = redirectInfo(false, false);
  result[308] = redirectInfo(true, false);

  result[412] = preconditionFailedInfo();

  return result;
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wglobal-constructors"
const std::unordered_map<uint, HttpStatusInfo> HTTP_STATUS_CODES = makeStatusCodes();
const HeaderWhitelist REQUEST_HEADER_WHITELIST(*WebSession::Context::HEADER_WHITELIST);
const HeaderWhitelist RESPONSE_HEADER_WHITELIST(*WebSession::Response::HEADER_WHITELIST);
#pragma clang diagnostic pop

class HttpParser final: public sandstorm::Handle::Server,
                  private http_parser,
                  private kj::TaskSet::ErrorHandler {
public:
  HttpParser(sandstorm::ByteStream::Client responseStream, bool ignoreBody = false)
    : responseStream(responseStream),
      ignoreBody(ignoreBody),
      taskSet(*this) {
    memset(&settings, 0, sizeof(settings));
    settings.on_status = &on_status;
    settings.on_header_field = &on_header_field;
    settings.on_header_value = &on_header_value;
    settings.on_body = &on_body;
    settings.on_headers_complete = &on_headers_complete;
    settings.on_message_complete = &on_message_complete;
    http_parser_init(this, HTTP_RESPONSE);
  }

  kj::Promise<kj::ArrayPtr<byte>> readResponse(kj::AsyncIoStream& stream) {
    // Read from the stream until we have enough data to forward the response. If the response
    // is streaming or an upgrade, then just read the headers; otherwise read the entire stream.
    // If the response is an upgrade, return any remainder bytes that should be forwarded to the
    // new web socket; otherwise return an empty array.

    return stream.tryRead(buffer, 1, sizeof(buffer)).then(
        [this, &stream](size_t actual) mutable -> kj::Promise<kj::ArrayPtr<byte>> {
      size_t nread = http_parser_execute(this, &settings, reinterpret_cast<char*>(buffer), actual);
      if (nread != actual && !upgrade) {
        const char* error = http_errno_description(HTTP_PARSER_ERRNO(this));
        KJ_FAIL_ASSERT("Failed to parse HTTP response from sandboxed app.", error);
      } else if (upgrade) {
        KJ_ASSERT(nread <= actual && nread >= 0);
        return kj::arrayPtr(buffer + nread, actual - nread);
      } else if (messageComplete || actual == 0) {
        // The parser is done or the stream has closed.
        KJ_ASSERT(headersComplete, "HTTP response from sandboxed app had incomplete headers.");
        return kj::arrayPtr(buffer, 0);
      } else if (headersComplete && status_code / 100 == 2) {
        isStreaming = true;

        KJ_IF_MAYBE(length, findHeader("content-length")) {
          auto req = responseStream.expectSizeRequest();
          req.setSize(length->parseAs<uint64_t>());
          taskSet.add(req.send().ignoreResult());
        }

        allocateNextWrite(body.asPtr().asBytes());
        body = kj::Vector<char>();
        taskSet.add(pumpWrites().catch_([this](kj::Exception&&) {
          // Error while writing.

          // Shut down input, so that the app knows it can stop generating it.
          responseInput->abortRead();

          // Drop the response stream, so that Sandstorm knows no more data is coming.
          responseStream = nullptr;

          // Mark aborted.
          aborted = true;
        }));
        return kj::arrayPtr(buffer,0);
      } else {
        return readResponse(stream);
      }
    });
  }

  void pumpStream(kj::Own<kj::AsyncIoStream>&& stream) {
    if (isStreaming) {
      responseInput = kj::mv(stream);
      startPumpStream();
    }
  }

  void build(WebSession::Response::Builder builder, sandstorm::Handle::Client handle) {
    KJ_ASSERT(!upgrade,
        "Sandboxed app attempted to upgrade protocol when client did not request this.");

    auto iter = HTTP_STATUS_CODES.find(status_code);
    HttpStatusInfo statusInfo;
    if (iter != HTTP_STATUS_CODES.end()) {
      statusInfo = iter->second;
    } else if (status_code / 100 == 4) {
      statusInfo.type = WebSession::Response::CLIENT_ERROR;
      statusInfo.clientErrorCode = WebSession::Response::ClientErrorCode::BAD_REQUEST;
    } else if (status_code / 100 == 5) {
      statusInfo.type = WebSession::Response::SERVER_ERROR;
    } else {
      KJ_FAIL_REQUIRE(
          "Application used unsupported HTTP status code.  Status codes must be whitelisted "
          "because some have sandbox-breaking effects.", (uint)status_code, statusString);
    }

    auto cookieList = builder.initSetCookies(cookies.size());
    for (size_t i: kj::indices(cookies)) {
      auto cookie = cookieList[i];
      cookie.setName(cookies[i].name);
      cookie.setValue(cookies[i].value);
      if (cookies[i].path != nullptr) {
        cookie.setPath(cookies[i].path);
      }
      switch (cookies[i].expirationType) {
        case Cookie::ExpirationType::NONE:
          cookie.getExpires().setNone();
          break;
        case Cookie::ExpirationType::ABSOLUTE:
          cookie.getExpires().setAbsolute(cookies[i].expires);
          break;
        case Cookie::ExpirationType::RELATIVE:
          cookie.getExpires().setRelative(cookies[i].expires);
          break;
      }
      cookie.setHttpOnly(cookies[i].httpOnly);
    }

    // Add whitelisted headers to additionalHeaders. With respect to security,
    // the consumers of  WebSession::Response are responsible for making sure
    // these headers are actually whitelisted. Since this bridge is included in
    // the app package and runs in the grain itself, we cannot trust that the
    // whitelist is correctly implemented here. An alternate implementation may
    // not respect the whitelist. However, for the sake of building a Response
    // that contains only valid headers, only whitelisted headers are added
    // here.

    // Add whitelisted headers, and headers matching the app prefix, to a
    // temporary vector of headers. It is possible for a header name to appear
    // more than once.
    kj::Vector<Header*> headersMatching;
    for (auto& header: headers) {
      if (RESPONSE_HEADER_WHITELIST.matches(header.first)) {
        headersMatching.add(&header.second);
      }
    }
    // Initialize additionalHeaders once we know how many headers to include.
    auto headerList = builder.initAdditionalHeaders(headersMatching.size());
    // Add the headers matching the whitelist
    int i = 0;
    for (auto header: headersMatching) {
      auto respHeader = headerList[i];
      respHeader.setName(header->name);
      respHeader.setValue(header->value);
      i++;
    }

    switch (statusInfo.type) {
      case WebSession::Response::CONTENT: {
        auto content = builder.initContent();
        content.setStatusCode(statusInfo.successCode);

        KJ_IF_MAYBE(encoding, findHeader("content-encoding")) {
          content.setEncoding(*encoding);
        }
        KJ_IF_MAYBE(language, findHeader("content-language")) {
          content.setLanguage(*language);
        }
        KJ_IF_MAYBE(mimeType, findHeader("content-type")) {
          content.setMimeType(*mimeType);
        }
        KJ_IF_MAYBE(etag, findHeader("etag")) {
          parseETag(*etag, content.initETag());
        }
        KJ_IF_MAYBE(disposition, findHeader("content-disposition")) {
          // Parse `attachment; filename="foo"`
          // TODO(cleanup):  This is awful.  Use KJ parser library?
          auto parts = split(*disposition, ';');
          if (parts.size() > 1 && trim(parts[0]) == "attachment") {
            // Starst with "attachment;".  Parse params.
            for (auto& part: parts.asPtr().slice(1, parts.size())) {
              // Parse a "name=value" parameter.
              for (size_t i: kj::indices(part)) {
                if (part[i] == '=') {
                  // Found '='.  Split and interpret.
                  if (trim(part.slice(0, i)) == "filename") {
                    // It's "filename=", the one we're looking for!
                    // We need to unquote/unescape the file name.
                    auto filename = trimArray(part.slice(i + 1, part.size()));

                    if (filename.size() >= 2 && filename[0] == '\"' &&
                        filename[filename.size() - 1] == '\"') {
                      // OK, it is in fact surrounded in quotes.  Unescape the contents.  The
                      // escaping scheme defined in RFC 822 is very simple:  a backslash followed
                      // by any character C is interpreted as simply C.
                      filename = filename.slice(1, filename.size() - 1);

                      kj::Vector<char> unescaped(filename.size() + 1);
                      for (size_t j = 0; j < filename.size(); j++) {
                        if (filename[j] == '\\') {
                          if (++j >= filename.size()) {
                            break;
                          }
                        }
                        unescaped.add(filename[j]);
                      }
                      unescaped.add('\0');

                      content.getDisposition().setDownload(
                          kj::StringPtr(unescaped.begin(), unescaped.size() - 1));
                    } else {
                      // Buggy app failed to quote filename, but we'll try to deal.
                      content.getDisposition().setDownload(kj::str(filename));
                    }
                  }
                  break;  // Only split at first '='.
                }
              }
            }
          }
        }

        if (isStreaming) {
          KJ_ASSERT(body.size() == 0);
          content.initBody().setStream(handle);
        } else {
          auto data = content.initBody().initBytes(body.size());
          memcpy(data.begin(), body.begin(), body.size());
        }
        break;
      }
      case WebSession::Response::NO_CONTENT: {
        auto noContent = builder.initNoContent();
        noContent.setShouldResetForm(statusInfo.noContent.shouldResetForm);
        KJ_IF_MAYBE(etag, findHeader("etag")) {
          parseETag(*etag, noContent.initETag());
        }
        break;
      }
      case WebSession::Response::PRECONDITION_FAILED: {
        auto preconditionFailed = builder.initPreconditionFailed();
        KJ_IF_MAYBE(etag, findHeader("etag")) {
          parseETag(*etag, preconditionFailed.initMatchingETag());
        }
        break;
      }
      case WebSession::Response::REDIRECT: {
        auto redirect = builder.initRedirect();
        redirect.setIsPermanent(statusInfo.redirect.isPermanent);
        redirect.setSwitchToGet(statusInfo.redirect.switchToGet);
        redirect.setLocation(KJ_ASSERT_NONNULL(findHeader("location"),
            "Application returned redirect response missing Location header.", (int)status_code));
        break;
      }
      case WebSession::Response::CLIENT_ERROR: {
        auto error = builder.initClientError();
        error.setStatusCode(statusInfo.clientErrorCode);
        auto text = error.initDescriptionHtml(body.size());
        memcpy(text.begin(), body.begin(), body.size());
        break;
      }
      case WebSession::Response::SERVER_ERROR: {
        auto text = builder.initServerError().initDescriptionHtml(body.size());
        memcpy(text.begin(), body.begin(), body.size());
        break;
      }
    }
  }

  void buildForWebSocket(WebSession::OpenWebSocketResults::Builder builder) {
    // TODO(soon):  If the app returned a normal response without upgrading, we should forward that
    //   through, as it's perfectly valid HTTP.  The WebSession interface currently does not
    //   support this.
    KJ_ASSERT((int)status_code == 101, "Sandboxed app does not support WebSocket.",
              (int)upgrade, (int)status_code, statusString);

    KJ_IF_MAYBE(protocol, findHeader("sec-websocket-protocol")) {
      auto parts = split(*protocol, ',');
      auto list = builder.initProtocol(parts.size());
      for (auto i: kj::indices(parts)) {
        auto trimmed = trim(parts[i]);
        memcpy(list.init(i, trimmed.size()).begin(), trimmed.begin(), trimmed.size());
      }
    }

    // TODO(soon):  Should we do more validation here, like checking the exact value of the Upgrade
    //   header or Sec-WebSocket-Accept?
  }

  void buildOptions(WebSession::Options::Builder builder) {
    KJ_ASSERT(!upgrade,
        "Sandboxed app attempted to upgrade protocol when client did not request this.");

    KJ_IF_MAYBE(dav, findHeader("dav")) {
      kj::Vector<kj::String> extensions;
      for (auto level: split(*dav, ',')) {
        auto trimmed = trim(level);
        if (trimmed == "1") {
          builder.setDavClass1(true);
        } else if (trimmed == "2") {
          builder.setDavClass2(true);
        } else if (trimmed == "3") {
          builder.setDavClass3(true);
        } else {
          extensions.add(kj::mv(trimmed));
        }
      }
      if (extensions.size() > 0) {
        auto list = builder.initDavExtensions(extensions.size());
        for (auto i: kj::indices(extensions)) {
          list.set(i, extensions[i]);
        }
      }
    }
  }

private:
  enum HeaderElementType { NONE, FIELD, VALUE };

  struct RawHeader {
    kj::Vector<char> name;
    kj::Vector<char> value;
  };

  struct Header {
    kj::String name;
    kj::String value;
  };

  struct Cookie {
    kj::String name;
    kj::String value;
    kj::String path;
    int64_t expires;

    enum ExpirationType {
      NONE, RELATIVE, ABSOLUTE
    };
    ExpirationType expirationType = NONE;

    bool httpOnly = false;
  };

  sandstorm::ByteStream::Client responseStream;
  bool ignoreBody;
  kj::TaskSet taskSet;
  http_parser_settings settings;
  kj::Vector<RawHeader> rawHeaders;
  kj::Vector<char> rawStatusString;
  HeaderElementType lastHeaderElement = NONE;
  std::map<kj::StringPtr, Header> headers;
  kj::Vector<char> body;
  kj::Vector<Cookie> cookies;
  kj::String statusString;
  bool headersComplete = false;
  bool messageComplete = false;
  bool isStreaming = false;
  bool streamDone = false;
  bool readStalled = false;
  bool aborted = false;

  kj::Maybe<kj::Own<kj::PromiseFulfiller<void>>> writeReady;
  capnp::StreamingRequest<ByteStream::WriteParams> nextWrite = nullptr;
  capnp::Orphan<capnp::Data> nextWriteData;
  size_t nextWriteSize = 0;  // how many bytes are already in `nextWriteData`

  kj::Own<kj::AsyncIoStream> responseInput;
  byte buffer[8192];

  kj::Promise<void> pumpWrites() {
    if (nextWriteSize > 0) {
      // Send the current write and allocate a new one.
      nextWriteData.truncate(nextWriteSize);
      nextWrite.adoptData(kj::mv(nextWriteData));

      auto result = nextWrite.send().then([this]() {
        return pumpWrites();
      });

      allocateNextWrite();

      return result;
    } else if (streamDone) {
      // No more bytes coming.
      nextWriteData = capnp::Orphan<capnp::Data>();
      nextWrite = nullptr;
      auto promise = responseStream.doneRequest().send().ignoreResult();
      responseStream = nullptr;
      return kj::mv(promise);
    } else {
      // No bytes received yet. Wait.
      auto paf = kj::newPromiseAndFulfiller<void>();
      writeReady = kj::mv(paf.fulfiller);
      return paf.promise.then([this]() { return pumpWrites(); });
    }
  }

  void allocateNextWrite(kj::ArrayPtr<const byte> initData = nullptr) {
    // For each write we start out allocating twice as much space as we actually managed to fill
    // on the previous write, though we cap this at 128k.
    size_t size = nextWriteSize * 2;
    if (size < sizeof(buffer)) {
      size = sizeof(buffer);
    } else if (size > (128u << 10)) {
      size = (128u << 10);
    }

    size = kj::max(size, initData.size());

    nextWriteData = capnp::Orphan<capnp::Data>();
    nextWrite = responseStream.writeRequest();
    nextWriteData = capnp::Orphanage::getForMessageContaining(
        ByteStream::WriteParams::Builder(nextWrite))
        .newOrphan<capnp::Data>(size);

    nextWriteSize = initData.size();
    if (initData.size() > 0) {
      memcpy(nextWriteData.get().begin(), initData.begin(), initData.size());
    }

    if (readStalled) {
      // Start reading again.
      readStalled = false;
      startPumpStream();
    }
  }

  void startPumpStream() {
    taskSet.add(pumpStreamInternal().catch_([this](kj::Exception&& e) {
      // Error while reading.

      // Drop the response stream, so that Sandstorm knows no more data is coming.
      responseStream = nullptr;
    }));
  }

  kj::Promise<void> pumpStreamInternal() {
    // Read HTTP response data coming out of the app.

    if (aborted) {
      // Output failed; give up.
      return kj::READY_NOW;
    }

    // Make sure not to read more bytes than would fit in our output buffer.
    size_t n = kj::min(sizeof(buffer), nextWriteData.getReader().size() - nextWriteSize);

    if (n == 0) {
      // We're out of space. Wait.
      readStalled = true;
      return kj::READY_NOW;
    }

    return responseInput->tryRead(buffer, 1, n)
        .then([this](size_t actual) -> kj::Promise<void> {
      if (aborted) {
        // Output failed; give up.
        return kj::READY_NOW;
      }

      size_t nread = http_parser_execute(this, &settings, reinterpret_cast<char*>(buffer), actual);
      if (nread != actual) {
        // The parser failed.
        const char* error = http_errno_description(HTTP_PARSER_ERRNO(this));
        KJ_FAIL_ASSERT("Failed to parse HTTP response from sandboxed app.", error);
      } else if (messageComplete || actual == 0) {
        // The parser is done or the stream has closed.
        streamDone = true;
        KJ_IF_MAYBE(w, writeReady) {
          w->get()->fulfill();
          writeReady = nullptr;
        }
        return kj::READY_NOW;
      } else {
        return pumpStreamInternal();
      }
    });
  }

  void taskFailed(kj::Exception&& exception) override {
    KJ_LOG(ERROR, exception);
  }

  kj::Maybe<kj::StringPtr> findHeader(kj::StringPtr name) {
    auto iter = headers.find(name);
    if (iter == headers.end()) {
      return nullptr;
    } else {
      return kj::StringPtr(iter->second.value);
    }
  }

  void onStatus(kj::ArrayPtr<const char> status) {
    rawStatusString.addAll(status);
  }

  void onHeaderField(kj::ArrayPtr<const char> name) {
    if (lastHeaderElement != FIELD) {
      rawHeaders.resize(rawHeaders.size() + 1);
    }
    rawHeaders[rawHeaders.size() - 1].name.addAll(name);
    lastHeaderElement = FIELD;
  }

  void onHeaderValue(kj::ArrayPtr<const char> value) {
    rawHeaders[rawHeaders.size() - 1].value.addAll(value);
    lastHeaderElement = VALUE;
  }

  void addHeader(RawHeader &rawHeader) {
    auto name = kj::heapString(rawHeader.name);
    toLower(name);
    kj::ArrayPtr<const char> value = rawHeader.value.asPtr();

    if (name == "set-cookie") {
      // Really ugly cookie-parsing code.
      // TODO(cleanup):  Clean up.
      bool isFirst = true;
      Cookie cookie;
      for (auto part: split(value, ';')) {
        if (isFirst) {
          isFirst = false;
          cookie.name = trim(KJ_ASSERT_NONNULL(splitFirst(part, '='),
              "Invalid cookie header from app.", value));
          cookie.value = trim(part);
        } else KJ_IF_MAYBE(name, splitFirst(part, '=')) {
          auto prop = trim(*name);
          toLower(prop);
          if (prop == "expires") {
            auto value = trim(part);
            // Wed, 15 Nov 1995 06:25:24 GMT
            struct tm t;
            memset(&t, 0, sizeof(t));

            // There are three allowed formats for HTTP dates.  Ugh.
            char* end = strptime(value.cStr(), "%a, %d %b %Y %T GMT", &t);
            if (end == nullptr) {
              end = strptime(value.cStr(), "%a, %d-%b-%y %T GMT", &t);
              if (end == nullptr) {
                end = strptime(value.cStr(), "%a %b %d %T %Y", &t);
                if (end == nullptr) {
                  // Not valid per HTTP spec, but MediaWiki seems to return this format sometimes.
                  end = strptime(value.cStr(), "%a, %d-%b-%Y %T GMT", &t);
                  if (end == nullptr) {
                    // Not valid per HTTP spec, but used by Rack.
                    end = strptime(value.cStr(), "%a, %d %b %Y %T -0000", &t);
                  }
                }
              }
            }
            KJ_ASSERT(end != nullptr && *end == '\0', "Invalid HTTP date from app.", value);
            cookie.expires = timegm(&t);
            cookie.expirationType = Cookie::ExpirationType::ABSOLUTE;
          } else if (prop == "max-age") {
            auto value = trim(part);
            char* end;
            cookie.expires = strtoull(value.cStr(), &end, 10);
            KJ_ASSERT(end > value.begin() && *end == '\0', "Invalid cookie max-age app.", value);
            cookie.expirationType = Cookie::ExpirationType::RELATIVE;
          } else if (prop == "path") {
            cookie.path = trim(part);
          } else {
            // Ignore other properties:
            //   Path:  Not useful on the modern same-origin-policy web.
            //   Domain:  We do not allow the app to publish cookies visible to other hosts in the
            //     domain.
          }
        } else {
          auto prop = trim(part);
          toLower(prop);
          if (prop == "httponly") {
            cookie.httpOnly = true;
          } else {
            // Ignore other properties:
            //   Secure:  We always set this, since we always require https.
          }
        }
      }

      cookies.add(kj::mv(cookie));

    } else {
      auto& slot = headers[name];
      if (slot.name != nullptr) {
        // Multiple instances of the same header are equivalent to comma-delimited.
        slot.value = kj::str(kj::mv(slot.value), ", ", value);
      } else {
        slot = Header { kj::mv(name), kj::heapString(value) };
      }
    }
  }


  void onBody(kj::ArrayPtr<const char> data) {
    if (isStreaming) {
      // Copy into the buffer we're working on.
      kj::ArrayPtr<byte> buffer = nextWriteData.get();
      buffer = buffer.slice(nextWriteSize, buffer.size());
      KJ_ASSERT(data.size() <= buffer.size(), data.size(), buffer.size(), nextWriteSize);
      memcpy(buffer.begin(), data.begin(), data.size());
      nextWriteSize += data.size();

      // Indicate data is ready. (Most of these fulfill() calls will be no-ops if no one is
      // waiting.)
      KJ_IF_MAYBE(w, writeReady) {
        w->get()->fulfill();
        writeReady = nullptr;
      }
    } else {
      body.addAll(data);
    }
  }

  bool onHeadersComplete() {
    for (auto &rawHeader : rawHeaders) {
      addHeader(rawHeader);
    }

    statusString = kj::heapString(rawStatusString);

    headersComplete = true;
    KJ_ASSERT((int)status_code >= 100, (int)status_code);
    return ignoreBody;
  }

  void onMessageComplete() {
    messageComplete = true;
  }

  static int on_headers_complete(http_parser *p) {
    // For other http callbacks, we use the ON_EVENT macro defined below,
    // but we can't for on_headers_complete because its return value has a special
    // case: We return 1 to indicate that the parser should not expect a body,
    // whereas for all other event callbacks, non-zero indicates an error.
    bool ignoreBody = static_cast<HttpParser*>(p)->onHeadersComplete();
    return (ignoreBody)? 1 : 0;
  }

#define ON_DATA(lower, title) \
  static int on_##lower(http_parser* p, const char* d, size_t s) { \
    static_cast<HttpParser*>(p)->on##title(kj::arrayPtr(d, s)); \
    return 0; \
  }
#define ON_EVENT(lower, title) \
  static int on_##lower(http_parser* p) { \
    static_cast<HttpParser*>(p)->on##title(); \
    return 0; \
  }

  ON_DATA(status, Status)
  ON_DATA(header_field, HeaderField)
  ON_DATA(header_value, HeaderValue)
  ON_DATA(body, Body)
  ON_EVENT(message_complete, MessageComplete)
#undef ON_DATA
#undef ON_EVENT

  static void maybePrintInvalidEtagWarning(kj::StringPtr input) {
    static bool alreadyLoggedMessage = false;
    if (alreadyLoggedMessage) {
      // We already logged the message once this session, which is plenty for now.
    } else {
      KJ_LOG(ERROR, "HTTP protocol error, dropping ETag: app returned invalid ETag data", input);
      KJ_LOG(ERROR, "See Sandstorm documentation: "
             "https://docs.sandstorm.io/en/latest/search.html?q=invalid+etag+data");
      alreadyLoggedMessage = true;
    }
  }

  static void parseETag(kj::StringPtr input, WebSession::ETag::Builder builder) {
    auto trimmed = trim(input);
    input = trimmed;
    if (input.startsWith("W/")) {
      input = input.slice(2);
      builder.setWeak(true);
    }

    // Apps sometimes send invalid ETag data. Rather than crash, we log a warning, due to #2295.
    if (! (input.endsWith("\"") && input.size() > 1)) {
      maybePrintInvalidEtagWarning(input);
      return;
    }

    bool escaped = false;
    kj::Vector<char> result(input.size() - 2);
    for (char c: input.slice(1, input.size() - 1)) {
      if (escaped) {
        escaped = false;
      } else {
        if (c == '"') {
          maybePrintInvalidEtagWarning(input);
          return;
        }
        if (c == '\\') {
          escaped = true;
          continue;
        }
      }
      result.add(c);
    }

    memcpy(builder.initValue(result.size()).begin(), result.begin(), result.size());
  }
};

// A wrapper around app-provided objects that implement AppPersistent. We intercept
// calls to AppPersistent.save() via a membrane, and then handle them with this class,
// which wraps the apps' returned objectId value in a BridgeObjectId.
class AppPersistentWrapper final: public AppPersistent<BridgeObjectId>::Server {
public:
  AppPersistentWrapper(AppPersistent<>::Client wrapped)
    : wrapped(wrapped)
  {}

  kj::Promise<void> save(SaveContext context) override {
    return wrapped.saveRequest().send().then([context](auto resp) mutable -> kj::Promise<void> {
        auto results = context.initResults();
        results.setLabel(resp.getLabel());
        results.initObjectId().initApplication().set(resp.getObjectId());
        return kj::READY_NOW;
    });
  }
private:
  AppPersistent<>::Client wrapped;
};

// Membrane policy, used to intercept calls to AppPersistent.save() on objects
// provided by the application.
class SaveMembranePolicy final: public capnp::MembranePolicy, public kj::Refcounted {
public:
  kj::Maybe<capnp::Capability::Client> inboundCall(
      uint64_t interfaceId, uint16_t methodId, capnp::Capability::Client target) override {
    if(interfaceId == capnp::typeId<AppPersistent<>>()) {
      return AppPersistent<BridgeObjectId>::Client(kj::heap(
        AppPersistentWrapper(target.castAs<AppPersistent<>>())
      ));
    }
    return nullptr;
  }

  kj::Maybe<capnp::Capability::Client> outboundCall(
      uint64_t interfaceId, uint16_t methodId, capnp::Capability::Client target) override {
    if(interfaceId == capnp::typeId<AppPersistent<>>()) {
      // In principle we should do some kind of wrapping/unwrapping to make this
      // work transparently, including for cases where a call goes into and back out
      // of the membrane for some reason, but:
      //
      // - That seems like a lot of extra logic to handle a case that should basically
      //   never happen.
      // - If the app is making outbound calls to AppPersistent, something very strange
      //   is going on; perhaps it is good policy to block this anyway.
      KJ_FAIL_REQUIRE("Unexpected outgoing call to method of AppPersistent.");
    }
    return nullptr;
  }

  kj::Own<capnp::MembranePolicy> addRef() override {
    return kj::addRef(*this);
  }
private:
};

class WebSocketPump final: public WebSession::WebSocketStream::Server,
                           private kj::TaskSet::ErrorHandler {
public:
  WebSocketPump(kj::Own<kj::AsyncIoStream> serverStream,
                WebSession::WebSocketStream::Client clientStream)
      : serverStream(kj::mv(serverStream)),
        clientStream(kj::mv(clientStream)),
        upstreamOp(kj::READY_NOW),
        tasks(*this) {}

  void pump() {
    // Repeatedly read from serverStream and write to clientStream.
    tasks.add(serverStream->tryRead(buffer, 1, sizeof(buffer))
        .then([this](size_t amount) {
      if (amount > 0) {
        sendData(kj::arrayPtr(buffer, amount));
        pump();
      } else {
        // EOF.
        clientStream = nullptr;
      }
    }));
  }

  void sendData(kj::ArrayPtr<byte> data) {
    // Write the given bytes to clientStream.
    auto request = clientStream.sendBytesRequest(
        capnp::MessageSize { data.size() / sizeof(capnp::word) + 8, 0 });
    request.setMessage(data);
    tasks.add(request.send());
  }

protected:
  kj::Promise<void> sendBytes(SendBytesContext context) override {
    // Received bytes from the client.  Write them to serverStream.
    auto forked = upstreamOp.then([context,this]() mutable {
      auto message = context.getParams().getMessage();
      return serverStream->write(message.begin(), message.size());
    }).fork();
    upstreamOp = forked.addBranch();
    return forked.addBranch();
  }

private:
  kj::Own<kj::AsyncIoStream> serverStream;
  WebSession::WebSocketStream::Client clientStream;

  kj::Promise<void> upstreamOp;
  // The promise working on writing data to serverStream.  AsyncIoStream wants only one write() at
  // a time, so new writes have to wait for the previous write to finish.

  kj::TaskSet tasks;
  // Pending calls to clientStream.sendBytes() and serverStream.read().

  byte buffer[4096];

  void taskFailed(kj::Exception&& exception) override {
    // TODO(soon):  What do we do when a server -> client send throws?  Probably just ignore it;
    //   WebSocket datagrams are intended to be one-way and thus the application protocol on top of
    //   them needs to implement acks at a higher level.  If the client has disconnected, we expect
    //   the whole pump will be destroyed shortly anyway.
    KJ_LOG(ERROR, exception);
  }
};

class RefcountedAsyncIoStream: public kj::AsyncIoStream, public kj::Refcounted {
public:
  RefcountedAsyncIoStream(kj::Own<kj::AsyncIoStream>&& stream)
      : stream(kj::mv(stream)) {}

  kj::Promise<size_t> read(void* buffer, size_t minBytes, size_t maxBytes) override {
    return stream->read(buffer, minBytes, maxBytes);
  }
  kj::Promise<size_t> tryRead(void* buffer, size_t minBytes, size_t maxBytes) override {
    return stream->tryRead(buffer, minBytes, maxBytes);
  }
  kj::Promise<void> write(const void* buffer, size_t size) override {
    return stream->write(buffer, size);
  }
  kj::Promise<void> write(kj::ArrayPtr<const kj::ArrayPtr<const byte>> pieces) override {
    return stream->write(pieces);
  }
  void shutdownWrite() override {
    return stream->shutdownWrite();
  }
  kj::Promise<void> whenWriteDisconnected() override {
    return stream->whenWriteDisconnected();
  }

private:
  kj::Own<kj::AsyncIoStream> stream;
};

class RequestStreamImpl final: public WebSession::RequestStream::Server {
public:
  RequestStreamImpl(kj::String httpRequest,
                    kj::Own<kj::AsyncIoStream> stream,
                    sandstorm::ByteStream::Client responseStream)
      : stream(kj::refcounted<RefcountedAsyncIoStream>(kj::mv(stream))),
        responseStream(responseStream),
        httpRequest(kj::mv(httpRequest)) {}

  kj::Promise<void> getResponse(GetResponseContext context) override {
    KJ_REQUIRE(!getResponseCalled, "getResponse() called more than once");
    getResponseCalled = true;

    // Remember that this is expected to be called *before* done() is called, so that the
    // application can start sending back data before it has received the entire request if it so
    // desires.

    auto parser = kj::heap<HttpParser>(responseStream);
    auto results = context.getResults();

    return parser->readResponse(*stream).then(
        [this, results, KJ_MVCAP(parser)]
        (kj::ArrayPtr<byte> remainder) mutable {
      KJ_ASSERT(remainder.size() == 0);
      parser->pumpStream(kj::addRef(*stream));
      auto &parserRef = *parser;
      sandstorm::Handle::Client handle = kj::mv(parser);
      parserRef.build(results, handle);
    });
  }

  kj::Promise<void> write(WriteContext context) override {
    KJ_REQUIRE(!doneCalled, "write() called after done()");
    writeHeadersOnce(nullptr);

    auto data = context.getParams().getData();
    bytesReceived += data.size();
    KJ_IF_MAYBE(s, expectedSize) {
      KJ_REQUIRE(bytesReceived <= *s, "received more bytes than expected");
    }

    // Forward the data.
    auto promise = previousWrite.then([this, data]() {
      if (isChunked) {
        kj::String chunkSize = kj::str(kj::hex(data.size()), "\r\n");
        kj::ArrayPtr<char> buffer = chunkSize.asArray();
        return stream->write(buffer.begin(), buffer.size())
            .attach(kj::mv(chunkSize))
            .then([this, data] () {
          return stream->write(data.begin(), data.size()).then([this] () {
            return stream->write("\r\n", 2);
          });
        });
      } else {
        return stream->write(data.begin(), data.size());
      }
    });
    auto fork = promise.fork();
    previousWrite = fork.addBranch();
    return fork.addBranch();
  }

  kj::Promise<void> done(DoneContext context) override {
    KJ_IF_MAYBE(s, expectedSize) {
      KJ_REQUIRE(bytesReceived == *s,
          "done() called before all bytes expected via expectedSize() were written");
    }
    KJ_REQUIRE(!doneCalled, "done() called twice");
    doneCalled = true;

    // If we haven't written headers yet, then the content is empty, so we can pass zero for the
    // expected size. (If we have written headers then the size we pass will be ignored.)
    writeHeadersOnce(kj::implicitCast<uint64_t>(0));

    if (isChunked) {
      previousWrite = previousWrite.then([this]() {
        return stream->write("0\r\n\r\n", 5);
      });
    }

    auto fork = previousWrite.fork();
    previousWrite = fork.addBranch();
    return fork.addBranch();
  }

  kj::Promise<void> expectSize(ExpectSizeContext context) override {
    uint64_t size = context.getParams().getSize();
    expectedSize = bytesReceived + size;
    writeHeadersOnce(size);
    return kj::READY_NOW;
  }

private:
  kj::Own<RefcountedAsyncIoStream> stream;
  sandstorm::ByteStream::Client responseStream;
  bool doneCalled = false;
  bool getResponseCalled = false;
  bool isChunked = true; // chunked unless we get expectSize() before we write the headers
  uint64_t bytesReceived = 0;
  kj::Maybe<uint64_t> expectedSize;
  kj::Promise<void> previousWrite = nullptr;  // initialized in writeHeadersOnce()
  kj::Maybe<kj::String> httpRequest;

  void writeHeadersOnce(kj::Maybe<uint64_t> contentLength) {
    KJ_IF_MAYBE(r, httpRequest) {
      // We haven't sent the request yet.
      kj::String reqString = kj::mv(*r);
      httpRequest = nullptr;

      // Hackily splice in content-length or transfer-encoding header.
      KJ_ASSERT(reqString.endsWith("\r\n\r\n"));
      KJ_IF_MAYBE(l, contentLength) {
        isChunked = false;
        reqString = kj::str(
            reqString.slice(0, reqString.size() - 2),
            "Content-Length: ", *l, "\r\n"
            "\r\n");
      } else {
        reqString = kj::str(
            reqString.slice(0, reqString.size() - 2),
            "Transfer-Encoding: chunked\r\n"
            "\r\n");
      }

      auto bytes = toBytes(reqString);
      kj::ArrayPtr<const byte> bytesRef = bytes;
      previousWrite = stream->write(bytesRef.begin(), bytesRef.size()).attach(kj::mv(bytes));
    }
  }
};

template<class T>
kj::Maybe<T&> findInMap(std::map<kj::StringPtr, T>& map, const kj::StringPtr& id) {
  auto iter = map.find(id);
  if(iter == map.end()) {
    return nullptr;
  }
  return iter->second;
}

class BridgeContext: private kj::TaskSet::ErrorHandler {
public:
  BridgeContext(SandstormApi<BridgeObjectId>::Client apiCap, spk::BridgeConfig::Reader config)
      : apiCap(kj::mv(apiCap)), config(config),
        identitiesDir(openIdentitiesDir(config)),
        trashDir(openTrashDir(config)), tasks(*this) {}

  kj::String formatPermissions(capnp::List<bool>::Reader userPermissions) {
    auto configPermissions = config.getViewInfo().getPermissions();
    kj::Vector<kj::String> permissionVec(configPermissions.size());

    for (uint i = 0; i < configPermissions.size() && i < userPermissions.size(); ++i) {
      if (userPermissions[i]) {
        permissionVec.add(kj::str(configPermissions[i].getName()));
      }
    }
    return kj::strArray(permissionVec, ",");
  }

  capnp::List<spk::BridgeConfig::PowerboxApi>::Reader getPowerboxApis() {
    return config.getPowerboxApis();
  }

  void saveIdentity(capnp::Data::Reader identityId, Identity::Client identity) {
    if (!config.getSaveIdentityCaps()) return;

    auto textId = textIdentityId(identityId);

    kj::StringPtr textIdRef = textId;
    if(liveIdentities.insert(std::make_pair(
        textIdRef, IdentityRecord { kj::mv(textId), kj::cp(identity) })).second) {
      // Newly-added to the map. Check if it's on disk.

      // Note that we know now that textIdRef will live forever, since it's in the map.

      if (faccessat(identitiesDir, textIdRef.cStr(), F_OK, AT_SYMLINK_NOFOLLOW) != 0) {
        // Not yet recorded to disk. Need to save a SturdyRef.
        saveIdentityInternal(textIdRef, kj::mv(identity));
      } else {
        // Try restoring the existing SturdyRef and re-save on failure.
        tasks.add(loadIdentityFromDisk(textIdRef).whenResolved().catch_(
            [this, textIdRef, KJ_MVCAP(identity)](auto error) mutable {
          if (error.getType() == kj::Exception::Type::FAILED) {
            saveIdentityInternal(textIdRef, kj::mv(identity));
          }
        }));
      }
    }
  }

  Identity::Client loadIdentity(kj::StringPtr origId) {
    // Obtain the identity capability for the given identity ID.

    KJ_REQUIRE(config.getSaveIdentityCaps(),
        "sandstorm-http-bridge is not configured to save identity capabilities",
        "please add `saveIdentityCaps = true` to your bridgeConfig in sandstorm-pkgdef.capnp");

    // Copy string to use as map key.
    auto textId = kj::heapString(origId);

    auto iter = liveIdentities.find(textId);
    if (iter == liveIdentities.end()) {
      // Not in the map. Load from disk.
      Identity::Client identity = loadIdentityFromDisk(textId);

      tasks.add(identity.whenResolved().then([this, KJ_MVCAP(textId), identity]() mutable {
        // Successfully resolved. Add to map.
        kj::StringPtr textIdRef = textId;
        KJ_ASSERT(liveIdentities.insert(std::make_pair(
          textIdRef, IdentityRecord { kj::mv(textId), kj::mv(identity) })).second);
      }, [] (auto e) {
        // Ignore the error here because the returned capability will report it upon use.
      }));

      return kj::mv(identity);
    } else {
      // Identity is in the map.
      Identity::Client identity = iter->second.identity;

      // We need to verify the capability is still connected. Send a dummy call to check. We'll
      // use a known-invalid type ID / method number and expect to get an UNIMPLEMENTED error.
      auto ping = identity.typelessRequest(0, 65535, capnp::MessageSize { 4, 0 });
      ping.initAsAnyStruct(0, 0);
      return ping.send().then([identity](auto&&) mutable -> kj::Promise<Identity::Client> {
        // Weird, we shouldn't get here.
        KJ_LOG(ERROR, "dummy ping request should have failed with UNIMPLEMENTED");

        // But clearly we are still connected, so continue.
        return kj::mv(identity);
      }, [this,KJ_MVCAP(textId),identity](kj::Exception&& e2) mutable
                                      -> kj::Promise<Identity::Client> {
        if (e2.getType() == kj::Exception::Type::DISCONNECTED) {
          // Disconnected. We'll need to reload from disk.
          Identity::Client newIdentity = loadIdentityFromDisk(textId);
          tasks.add(newIdentity.whenResolved().then([this, KJ_MVCAP(textId), newIdentity]() mutable {
            // Save the new identity to the map so that we don't have to reload it again.
            auto iter = liveIdentities.find(textId);
            KJ_ASSERT(iter != liveIdentities.end());
            iter->second.identity = kj::mv(newIdentity);
          }, [] (auto e) {
            // Ignore the error here because the returned capability will report it upon use.
          }));

          return kj::mv(newIdentity);
        } else {
          // Some other error -- meaning we're NOT disconnected, so go ahead and use the cap.
          return kj::mv(identity);
        }
      });
    }
  }

  kj::Maybe<SessionContext::Client&> findSessionContext(const kj::StringPtr& id) {
    KJ_IF_MAYBE(record, findInMap(sessions, id)) {
      return record->sessionCtx;
    } else {
      return nullptr;
    }
  }

  kj::Maybe<SessionInfo::Reader> findSessionInfo(const kj::StringPtr& id) {
    KJ_IF_MAYBE(record, findInMap(sessions, id)) {
      return record->sessionInfo;
    } else {
      return nullptr;
    }
  }

  void eraseSession(const kj::StringPtr& id) {
    sessions.erase(id);
  }

  void insertSession(const kj::StringPtr& id, SessionContext::Client& session, SessionInfo::Reader sessionInfo) {
    sessions.insert({
      kj::StringPtr(id),
      SessionRecord {session, sessionInfo}
    });
  }

private:
  SandstormApi<BridgeObjectId>::Client apiCap;
  spk::BridgeConfig::Reader config;
  kj::AutoCloseFd identitiesDir;
  kj::AutoCloseFd trashDir;

  struct SessionRecord {
    SessionRecord(const SessionRecord& other) = default;
    SessionRecord(SessionRecord&& other) = default;

    SessionContext::Client& sessionCtx;
    SessionInfo::Reader sessionInfo;
  };
  std::map<kj::StringPtr, SessionRecord> sessions;

  struct IdentityRecord {
    IdentityRecord(const IdentityRecord& other) = delete;
    IdentityRecord(IdentityRecord&& other) = default;

    kj::String textId;
    Identity::Client identity;
  };
  std::map<kj::StringPtr, IdentityRecord> liveIdentities;

  kj::TaskSet tasks;

  virtual void taskFailed(kj::Exception&& exception) override {
    KJ_LOG(ERROR, exception);
  }

  static kj::AutoCloseFd openIdentitiesDir(spk::BridgeConfig::Reader config) {
    if (!config.getSaveIdentityCaps()) return kj::AutoCloseFd();

    recursivelyCreateParent("/var/.sandstorm-http-bridge/identities/foo");

    // Note: Using O_PATH here would prevent fsync().
    return raiiOpen("/var/.sandstorm-http-bridge/identities",
                    O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  }

  static kj::AutoCloseFd openTrashDir(spk::BridgeConfig::Reader config) {
    if (!config.getSaveIdentityCaps()) return kj::AutoCloseFd();

    recursivelyCreateParent("/var/.sandstorm-http-bridge/trash/foo");

    // Note: Using O_PATH here would prevent fsync().
    return raiiOpen("/var/.sandstorm-http-bridge/trash",
                    O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  }

  Identity::Client loadIdentityFromDisk(kj::StringPtr textId) {
    KJ_ASSERT(textId.size() == 32, "invalid identity ID", textId);
    for (char c: textId) {
      if ((c < '0' || '9' < c) && (c < 'a' && 'f' < c)) {
        KJ_FAIL_ASSERT("invalid identity ID", textId);
      }
    }

    char buf[512];
    ssize_t n;
    KJ_SYSCALL(n = readlinkat(identitiesDir, textId.cStr(), buf, sizeof(buf)));
    KJ_ASSERT(n < sizeof(buf), "token too long?");
    buf[n] = '\0';

    auto req = apiCap.restoreRequest();
    req.setToken(kj::decodeBinaryUriComponent(buf));

    return req.send().getCap().castAs<Identity>();
  }

  void saveIdentityInternal(kj::StringPtr textId, Identity::Client identity) {
    // Writes the identity to disk, assuming that either we have not saved this identity yet
    // or we have recently observed our existing save to be broken.

    auto req = apiCap.saveRequest();
    req.setCap(identity);
    req.initLabel().setDefaultText("user identity");
    tasks.add(req.send().then([this,textId](auto result) -> void {
      // Sandstorm tokens are primarily text but use percent-encoding to be safe.
      auto tokenText = kj::encodeUriComponent(result.getToken());

      // Clean up any existing symlink.
      dropIdentity(textId);

      // Store as a symlink. ext4 can store up to 60 bytes directly in the inode, avoiding
      // allocating a block.
      KJ_SYSCALL(symlinkat(tokenText.cStr(), identitiesDir, textId.cStr()));

      // Make sure it's really saved.
      KJ_SYSCALL(fsync(identitiesDir));
    }));
  }

  void dropIdentity(kj::StringPtr textId) {
    auto symlink = kj::heapString(textId);

    if (faccessat(identitiesDir, symlink.cStr(), F_OK, AT_SYMLINK_NOFOLLOW) == 0) {
      char buf[512];
      ssize_t n;
      KJ_SYSCALL(n = readlinkat(identitiesDir, symlink.cStr(), buf, sizeof(buf)));
      KJ_ASSERT(n < sizeof(buf), "token too long?");
      buf[n] = '\0';

      // We name the trash file after the token, not the identity ID. This way, it's okay
      // if we overwrite an existing entry of the trash directory.
      auto trashSymlink = kj::heapString(buf);
      KJ_SYSCALL(renameat(identitiesDir, symlink.cStr(), trashDir, trashSymlink.cStr()));

      auto req = apiCap.dropRequest();
      req.setToken(kj::decodeBinaryUriComponent(buf));
      tasks.add(req.send().then([KJ_MVCAP(trashSymlink), this](auto response) -> void {
        KJ_SYSCALL(unlinkat(trashDir, trashSymlink.cStr(), 0));
      }));

      // TODO(someday): Implement some kind of garbage collection that clears out the trash
      // directory periodically, to handle the rare case when the above drop() task fails to
      // run to completion.
    }
  }
};

class WebSessionImpl final: public BridgeHttpSession::Server {
public:
  WebSessionImpl(kj::NetworkAddress& serverAddr,
                 UserInfo::Reader userInfo, SessionContext::Client sessionContext,
                 BridgeContext& bridgeContext, kj::String&& sessionId, kj::String&& tabId,
                 kj::String&& basePath, kj::String&& userAgent, kj::String&& acceptLanguages,
                 kj::String&& rootPath, kj::String&& permissions,
                 kj::Maybe<kj::String> remoteAddress,
                 kj::Maybe<OwnCapnp<BridgeObjectId::HttpApi>>&& apiInfo,
                 SessionInfo::Reader sessionInfo)
      : serverAddr(serverAddr),
        sessionContext(kj::mv(sessionContext)),
        bridgeContext(bridgeContext),
        sessionId(kj::mv(sessionId)),
        tabId(kj::mv(tabId)),
        userDisplayName(kj::encodeUriComponent(userInfo.getDisplayName().getDefaultText())),
        userHandle(kj::heapString(userInfo.getPreferredHandle())),
        userPicture(kj::heapString(userInfo.getPictureUrl())),
        userPronouns(userInfo.getPronouns()),
        permissions(kj::mv(permissions)),
        basePath(kj::mv(basePath)),
        userAgent(kj::mv(userAgent)),
        acceptLanguages(kj::mv(acceptLanguages)),
        rootPath(kj::mv(rootPath)),
        remoteAddress(kj::mv(remoteAddress)),
        apiInfo(kj::mv(apiInfo)),
        sessionInfo(capnp::clone(sessionInfo)) {
    if (userInfo.hasIdentityId()) {
      userId = textIdentityId(userInfo.getIdentityId());
    }
    if (this->sessionId != nullptr) {
      bridgeContext.insertSession(
          kj::StringPtr(this->sessionId),
          this->sessionContext,
          *this->sessionInfo);
    }
  }

  ~WebSessionImpl() noexcept(false) {
    if (this->sessionId != nullptr) {
      bridgeContext.eraseSession(kj::StringPtr(sessionId));
    }
  }

  kj::Promise<void> get(GetContext context) override {
    GetParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders(
        params.getIgnoreBody() ? "HEAD" : "GET", params.getPath(), params.getContext());
    return sendRequest(toBytes(httpRequest), context, params.getIgnoreBody());
  }

  kj::Promise<void> post(PostContext context) override {
    PostParams::Reader params = context.getParams();
    auto content = params.getContent();
    kj::String httpRequest = makeHeaders("POST", params.getPath(), params.getContext(),
      kj::str("Content-Type: ", content.getMimeType()),
      kj::str("Content-Length: ", content.getContent().size()),
      content.hasEncoding() ? kj::str("Content-Encoding: ", content.getEncoding()) : nullptr);
    return sendRequest(toBytes(httpRequest, content.getContent()), context);
  }

  kj::Promise<void> put(PutContext context) override {
    PutParams::Reader params = context.getParams();
    auto content = params.getContent();
    kj::String httpRequest = makeHeaders("PUT", params.getPath(), params.getContext(),
      kj::str("Content-Type: ", content.getMimeType()),
      kj::str("Content-Length: ", content.getContent().size()),
      content.hasEncoding() ? kj::str("Content-Encoding: ", content.getEncoding()) : nullptr);
    return sendRequest(toBytes(httpRequest, content.getContent()), context);
  }

  kj::Promise<void> patch(PatchContext context) override {
    PatchParams::Reader params = context.getParams();
    auto content = params.getContent();
    kj::String httpRequest = makeHeaders("PATCH", params.getPath(), params.getContext(),
      kj::str("Content-Type: ", content.getMimeType()),
      kj::str("Content-Length: ", content.getContent().size()),
      content.hasEncoding() ? kj::str("Content-Encoding: ", content.getEncoding()) : nullptr);
    return sendRequest(toBytes(httpRequest, content.getContent()), context);
  }

  kj::Promise<void> delete_(DeleteContext context) override {
    DeleteParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders("DELETE", params.getPath(), params.getContext());
    return sendRequest(toBytes(httpRequest), context);
  }

  kj::Promise<void> propfind(PropfindContext context) override {
    PropfindParams::Reader params = context.getParams();

    const char* depth = "infinity";
    switch (params.getDepth()) {
      case WebSession::PropfindDepth::INFINITY_: depth = "infinity"; break;
      case WebSession::PropfindDepth::ZERO:      depth = "0"; break;
      case WebSession::PropfindDepth::ONE:       depth = "1"; break;
    }

    auto xml = params.getXmlContent();
    kj::String httpRequest = makeHeaders(
        "PROPFIND", params.getPath(), params.getContext(),
        kj::str("Content-Type: application/xml;charset=utf-8"),
        kj::str("Content-Length: ", xml.size()),
        kj::str("Depth: ", depth));
    return sendRequest(toBytes(httpRequest, xml.asBytes()), context);
  }

  kj::Promise<void> proppatch(ProppatchContext context) override {
    ProppatchParams::Reader params = context.getParams();
    auto xml = params.getXmlContent();
    kj::String httpRequest = makeHeaders(
        "PROPPATCH", params.getPath(), params.getContext(),
        kj::str("Content-Type: application/xml;charset=utf-8"),
        kj::str("Content-Length: ", xml.size()));
    return sendRequest(toBytes(httpRequest, xml.asBytes()), context);
  }

  kj::Promise<void> mkcol(MkcolContext context) override {
    MkcolParams::Reader params = context.getParams();
    auto content = params.getContent();
    kj::String httpRequest = makeHeaders(
        "MKCOL", params.getPath(), params.getContext(),
        kj::str("Content-Type: ", content.getMimeType()),
        kj::str("Content-Length: ", content.getContent().size()),
        content.hasEncoding() ? kj::str("Content-Encoding: ", content.getEncoding()) : nullptr);
    return sendRequest(toBytes(httpRequest, content.getContent()), context);
  }

  kj::Promise<void> copy(CopyContext context) override {
    CopyParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders(
        "COPY", params.getPath(), params.getContext(),
        makeDestinationHeader(params.getDestination()),
        makeOverwriteHeader(params.getNoOverwrite()),
        makeDepthHeader(params.getShallow()));
    return sendRequest(toBytes(httpRequest), context);
  }

  kj::Promise<void> move(MoveContext context) override {
    MoveParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders(
        "MOVE", params.getPath(), params.getContext(),
        makeDestinationHeader(params.getDestination()),
        makeOverwriteHeader(params.getNoOverwrite()));
    return sendRequest(toBytes(httpRequest), context);
  }

  kj::Promise<void> lock(LockContext context) override {
    LockParams::Reader params = context.getParams();
    auto xml = params.getXmlContent();
    kj::String httpRequest = makeHeaders(
        "LOCK", params.getPath(), params.getContext(),
        kj::str("Content-Type: application/xml;charset=utf-8"),
        kj::str("Content-Length: ", xml.size()),
        makeDepthHeader(params.getShallow()));
    return sendRequest(toBytes(httpRequest, xml.asBytes()), context);
  }

  kj::Promise<void> unlock(UnlockContext context) override {
    UnlockParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders(
        "UNLOCK", params.getPath(), params.getContext(),
        kj::str("Lock-Token: ", params.getLockToken()));
    return sendRequest(toBytes(httpRequest, nullptr), context);
  }

  kj::Promise<void> acl(AclContext context) override {
    AclParams::Reader params = context.getParams();
    auto xml = params.getXmlContent();
    kj::String httpRequest = makeHeaders(
        "ACL", params.getPath(), params.getContext(),
        kj::str("Content-Type: application/xml;charset=utf-8"),
        kj::str("Content-Length: ", xml.size()));
    return sendRequest(toBytes(httpRequest, xml.asBytes()), context);
  }

  kj::Promise<void> report(ReportContext context) override {
    ReportParams::Reader params = context.getParams();
    auto content = params.getContent();
    kj::String httpRequest = makeHeaders(
        "REPORT", params.getPath(), params.getContext(),
        kj::str("Content-Type: ", content.getMimeType()),
        kj::str("Content-Length: ", content.getContent().size()),
        content.hasEncoding() ? kj::str("Content-Encoding: ", content.getEncoding()) : nullptr);
    return sendRequest(toBytes(httpRequest, content.getContent()), context);
  }

  kj::Promise<void> options(OptionsContext context) override {
    OptionsParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders("OPTIONS", params.getPath(), params.getContext());
    return sendOptionsRequest(kj::mv(httpRequest), context);
  }

  kj::Promise<void> postStreaming(PostStreamingContext context) override {
    PostStreamingParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders("POST", params.getPath(), params.getContext(),
        kj::str("Content-Type: ", params.getMimeType()),
        params.hasEncoding() ? kj::str("Content-Encoding: ", params.getEncoding()) : nullptr);
    return sendRequestStreaming(kj::mv(httpRequest), context);
  }

  kj::Promise<void> putStreaming(PutStreamingContext context) override {
    PutStreamingParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders("PUT", params.getPath(), params.getContext(),
        kj::str("Content-Type: ", params.getMimeType()),
        params.hasEncoding() ? kj::str("Content-Encoding: ", params.getEncoding()) : nullptr);
    return sendRequestStreaming(kj::mv(httpRequest), context);
  }

  kj::Promise<void> openWebSocket(OpenWebSocketContext context) override {
    // TODO(soon):  Use actual random Sec-WebSocket-Key?  Unclear if this has any importance when
    //   not trying to work around broken proxies.

    auto params = context.getParams();

    kj::Vector<kj::String> lines(16);

    lines.add(kj::str("GET ", rootPath, params.getPath(), " HTTP/1.1"));
    lines.add(kj::str("Upgrade: websocket"));
    lines.add(kj::str("Connection: Upgrade"));
    lines.add(kj::str("Sec-WebSocket-Key: mj9i153gxeYNlGDoKdoXOQ=="));
    auto protocols = params.getProtocol();
    if (protocols.size() > 0) {
      lines.add(kj::str("Sec-WebSocket-Protocol: ", kj::strArray(params.getProtocol(), ", ")));
    }
    lines.add(kj::str("Sec-WebSocket-Version: 13"));

    addCommonHeaders(lines, params.getContext());

    auto httpRequest = toBytes(catHeaderLines(lines));
    WebSession::WebSocketStream::Client clientStream = params.getClientStream();
    sandstorm::ByteStream::Client responseStream =
        context.getParams().getContext().getResponseStream();
    context.releaseParams();

    return serverAddr.connect().then(
        [KJ_MVCAP(httpRequest), KJ_MVCAP(clientStream), responseStream, context]
        (kj::Own<kj::AsyncIoStream>&& stream) mutable {
      kj::ArrayPtr<const byte> httpRequestRef = httpRequest;
      auto& streamRef = *stream;
      return streamRef.write(httpRequestRef.begin(), httpRequestRef.size())
          .attach(kj::mv(httpRequest))
          .then([KJ_MVCAP(stream), KJ_MVCAP(clientStream), responseStream, context]
                () mutable {
            auto parser = kj::heap<HttpParser>(responseStream);
            auto results = context.getResults();

            return parser->readResponse(*stream).then(
                [results, KJ_MVCAP(stream), KJ_MVCAP(clientStream), KJ_MVCAP(parser)]
                (kj::ArrayPtr<byte> remainder) mutable {
              auto pump = kj::heap<WebSocketPump>(kj::mv(stream), kj::mv(clientStream));
              parser->buildForWebSocket(results);
              if (remainder.size() > 0) {
                pump->sendData(remainder);
              }
              pump->pump();
              results.setServerStream(kj::mv(pump));
            });
          });
    });
  }

  kj::Promise<void> save(SaveContext context) override {
    KJ_IF_MAYBE(info, apiInfo) {
      auto results = context.getResults();
      results.initObjectId().setHttpApi(*info);
      for (auto meta: bridgeContext.getPowerboxApis()) {
        if (meta.getName() == info->getName()) {
          results.setLabel(meta.getDisplayInfo().getTitle());
          break;
        }
      }
      return kj::READY_NOW;
    } else {
      KJ_UNIMPLEMENTED("can't save() non-powerbox BridgeHttpSession");
    }
  }

private:
  kj::NetworkAddress& serverAddr;
  SessionContext::Client sessionContext;
  BridgeContext& bridgeContext;
  kj::String sessionId;
  kj::String tabId;
  kj::String userDisplayName;
  kj::String userHandle;
  kj::String userPicture;
  Profile::Pronouns userPronouns = Profile::Pronouns::NEUTRAL;
  kj::Maybe<kj::String> userId;
  kj::String permissions;
  kj::String basePath;
  kj::String userAgent;
  kj::String acceptLanguages;
  kj::String rootPath;
  spk::BridgeConfig::Reader config;
  kj::Maybe<kj::String> remoteAddress;
  kj::Maybe<OwnCapnp<BridgeObjectId::HttpApi>> apiInfo;
  kj::Own<SessionInfo::Reader> sessionInfo;

  kj::String makeHeaders(kj::StringPtr method, kj::StringPtr path,
                         WebSession::Context::Reader context,
                         kj::String extraHeader1 = nullptr,
                         kj::String extraHeader2 = nullptr,
                         kj::String extraHeader3 = nullptr) {
    kj::Vector<kj::String> lines(16);

    lines.add(kj::str(method, " ", rootPath, path, " HTTP/1.1"));
    lines.add(kj::str("Connection: close"));
    if (extraHeader1 != nullptr) {
      lines.add(kj::mv(extraHeader1));
    }
    if (extraHeader2 != nullptr) {
      lines.add(kj::mv(extraHeader2));
    }
    if (extraHeader3 != nullptr) {
      lines.add(kj::mv(extraHeader3));
    }
    if (acceptLanguages.size() > 0) {
      lines.add(kj::str("Accept-Language: ", acceptLanguages));
    }

    addCommonHeaders(lines, context);

    return catHeaderLines(lines);
  }

  static kj::String catHeaderLines(kj::Vector<kj::String>& lines) {
    for (auto& line: lines) {
      KJ_ASSERT(line.findFirst('\n') == nullptr,
                "HTTP header contained newline; blocking to prevent injection.");
    }

    return kj::strArray(lines, "\r\n");
  }

  void addCommonHeaders(kj::Vector<kj::String>& lines, WebSession::Context::Reader context) {
    if (userAgent.size() > 0) {
      lines.add(kj::str("User-Agent: ", userAgent));
    }
    lines.add(kj::str("X-Sandstorm-Tab-Id: ", tabId));
    lines.add(kj::str("X-Sandstorm-Username: ", userDisplayName));
    KJ_IF_MAYBE(u, userId) {
      lines.add(kj::str("X-Sandstorm-User-Id: ", *u));

      // Since the user is logged in, also include their other info.
      if (userHandle.size() > 0) {
        lines.add(kj::str("X-Sandstorm-Preferred-Handle: ", userHandle));
      }
      if (userPicture.size() > 0) {
        lines.add(kj::str("X-Sandstorm-User-Picture: ", userPicture));
      }
      capnp::EnumSchema schema = capnp::Schema::from<Profile::Pronouns>();
      uint pronounValue = static_cast<uint>(userPronouns);
      auto enumerants = schema.getEnumerants();
      if (pronounValue > 0 && pronounValue < enumerants.size()) {
        lines.add(kj::str("X-Sandstorm-User-Pronouns: ",
            enumerants[pronounValue].getProto().getName()));
      }
    }
    {
      // TODO(zenhack): there's probably an existing method to get the name
      // of a variant; look it up and just do that instead of doing all
      // this manually:
      auto setHeader = [&](const char *value) {
        lines.add(kj::str("X-Sandstorm-Session-Type: ", value));
      };
      switch(sessionInfo->which()) {
        case SessionInfo::Which::NORMAL:
          setHeader("normal");
          break;
        case SessionInfo::Which::REQUEST:
          setHeader("request");
          break;
        case SessionInfo::Which::OFFER:
          setHeader("offer");
          break;
        default:
          KJ_FAIL_ASSERT("Unknown session type.");
      }
    }
    lines.add(kj::str("X-Sandstorm-Permissions: ", permissions));
    if (basePath.size() > 0) {
      lines.add(kj::str("X-Sandstorm-Base-Path: ", basePath));
      lines.add(kj::str("Host: ", extractHostFromUrl(basePath)));
      lines.add(kj::str("X-Forwarded-Proto: ", extractProtocolFromUrl(basePath)));
    } else {
      // Dummy value. Some API servers (e.g. git-http-backend) fail if Host is not present.
      lines.add(kj::str("Host: sandbox"));
    }
    lines.add(kj::str("X-Sandstorm-Session-Id: ", sessionId));
    KJ_IF_MAYBE(addr, remoteAddress) {
      lines.add(kj::str("X-Real-IP: ", *addr));
    }
    KJ_IF_MAYBE(i, apiInfo) {
      lines.add(kj::str("X-Sandstorm-Api: ", i->getName()));
    }

    auto cookies = context.getCookies();
    if (cookies.size() > 0) {
      lines.add(kj::str("Cookie: ", kj::strArray(
            KJ_MAP(c, cookies) {
              return kj::str(c.getKey(), "=", c.getValue());
            }, "; ")));
    }
    auto acceptList = context.getAccept();
    if (acceptList.size() > 0) {
      lines.add(kj::str("Accept: ", kj::strArray(
            KJ_MAP(c, acceptList) {
              if (c.getQValue() == 1.0) {
                return kj::str(c.getMimeType());
              } else {
                return kj::str(c.getMimeType(), "; q=", c.getQValue());
              }
            }, ", ")));
    } else {
      lines.add(kj::str("Accept: */*"));
    }
    auto acceptEncodingList = context.getAcceptEncoding();
    if (acceptEncodingList.size() > 0) {
      lines.add(kj::str("Accept-Encoding: ", kj::strArray(
            KJ_MAP(c, acceptEncodingList) {
              if (c.getQValue() == 1.0) {
                return kj::str(c.getContentCoding());
              } else {
                return kj::str(c.getContentCoding(), "; q=", c.getQValue());
              }
            }, ", ")));
    }
    auto additionalHeaderList = context.getAdditionalHeaders();
    if (additionalHeaderList.size() > 0) {

      for (auto header: additionalHeaderList) {
        auto headerName = header.getName();
        auto headerValue = header.getValue();

        // Don't allow the header unless it is present in the whitelist. Note that Sandstorm never
        // sends non-whitelisted headers, but it's possible that another app had directly obtained
        // a WebSession capability to us, and that app could send whatever it wants, so we need
        // to check.
        if (REQUEST_HEADER_WHITELIST.matches(headerName)) {
          // Note that we check elsewhere that each line contains no newlines, to prevent
          // injections.
          lines.add(kj::str(headerName, ": ", headerValue));
        }
      }
    }
    auto eTagPrecondition = context.getETagPrecondition();
    switch (eTagPrecondition.which()) {
      case WebSession::Context::ETagPrecondition::NONE:
        break;
      case WebSession::Context::ETagPrecondition::EXISTS:
        lines.add(kj::str("If-Match: *"));
        break;
      case WebSession::Context::ETagPrecondition::DOESNT_EXIST:
        lines.add(kj::str("If-None-Match: *"));
        break;
      case WebSession::Context::ETagPrecondition::MATCHES_ONE_OF:
        lines.add(kj::str("If-Match: ", kj::strArray(
              KJ_MAP(e, eTagPrecondition.getMatchesOneOf()) {
                if (e.getWeak()) {
                  return kj::str("W/\"", e.getValue(), '"');
                } else {
                  return kj::str('"', e.getValue(), '"');
                }
              }, ", ")));
        break;
      case WebSession::Context::ETagPrecondition::MATCHES_NONE_OF:
        lines.add(kj::str("If-None-Match: ", kj::strArray(
              KJ_MAP(e, eTagPrecondition.getMatchesNoneOf()) {
                if (e.getWeak()) {
                  return kj::str("W/\"", e.getValue(), '"');
                } else {
                  return kj::str('"', e.getValue(), '"');
                }
              }, ", ")));
        break;
    }

    lines.add(kj::str(""));
    lines.add(kj::str(""));
  }

  template <typename Context>
  kj::Promise<void> sendRequest(kj::Array<byte> httpRequest, Context& context, bool ignoreBody = false) {
    sandstorm::ByteStream::Client responseStream =
        context.getParams().getContext().getResponseStream();
    context.releaseParams();
    return serverAddr.connect().then(
        [KJ_MVCAP(httpRequest), responseStream, context, ignoreBody]
        (kj::Own<kj::AsyncIoStream>&& stream) mutable {
      kj::ArrayPtr<const byte> httpRequestRef = httpRequest;
      auto& streamRef = *stream;
      return streamRef.write(httpRequestRef.begin(), httpRequestRef.size())
          .attach(kj::mv(httpRequest))
          .then([KJ_MVCAP(stream), responseStream, context, ignoreBody]() mutable {
        // Note:  Do not do stream->shutdownWrite() as some HTTP servers will decide to close the
        // socket immediately on EOF, even if they have not actually responded to previous requests
        // yet.
        auto parser = kj::heap<HttpParser>(responseStream, ignoreBody);
        auto results = context.getResults();

        return parser->readResponse(*stream).then(
            [results, KJ_MVCAP(stream), KJ_MVCAP(parser)]
            (kj::ArrayPtr<byte> remainder) mutable {
          KJ_ASSERT(remainder.size() == 0);
          parser->pumpStream(kj::mv(stream));
          auto &parserRef = *parser;
          sandstorm::Handle::Client handle = kj::mv(parser);
          parserRef.build(results, handle);
        });
      });
    });
  }

  template <typename Context>
  kj::Promise<void> sendRequestStreaming(kj::String httpRequest, Context& context) {
    sandstorm::ByteStream::Client responseStream =
      context.getParams().getContext().getResponseStream();
    context.releaseParams();
    return serverAddr.connect().then(
        [KJ_MVCAP(httpRequest), responseStream, context]
        (kj::Own<kj::AsyncIoStream>&& stream) mutable {
      auto requestStream = kj::heap<RequestStreamImpl>(
          kj::mv(httpRequest), kj::mv(stream), responseStream);
      context.getResults().setStream(kj::mv(requestStream));
    });
  }

  kj::Promise<void> sendOptionsRequest(kj::String httpRequest, OptionsContext& context) {
    context.releaseParams();
    return serverAddr.connect().then(
        [KJ_MVCAP(httpRequest), context]
        (kj::Own<kj::AsyncIoStream>&& stream) mutable {
      kj::StringPtr httpRequestRef = httpRequest;
      auto& streamRef = *stream;
      return streamRef.write(httpRequestRef.begin(), httpRequestRef.size())
          .attach(kj::mv(httpRequest))
          .then([KJ_MVCAP(stream), context]() mutable {
        // Note:  Do not do stream->shutdownWrite() as some HTTP servers will decide to close the
        // socket immediately on EOF, even if they have not actually responded to previous requests
        // yet.
        auto parser = kj::heap<HttpParser>(kj::heap<IgnoreStream>());

        return parser->readResponse(*stream).then(
            [context, KJ_MVCAP(stream), KJ_MVCAP(parser)]
            (kj::ArrayPtr<byte> remainder) mutable {
          KJ_ASSERT(remainder.size() == 0);
          parser->pumpStream(kj::mv(stream));
          auto &parserRef = *parser;
          parserRef.buildOptions(context.getResults());
        });
      });
    });
  }

  class IgnoreStream final: public ByteStream::Server {
  protected:
    kj::Promise<void> write(WriteContext context) override { return kj::READY_NOW; }
    kj::Promise<void> done(DoneContext context) override { return kj::READY_NOW; }
    kj::Promise<void> expectSize(ExpectSizeContext context) override { return kj::READY_NOW; }
  };

  kj::String makeDestinationHeader(kj::StringPtr destination) {
    for (char c: destination) {
      KJ_ASSERT(c > ' ' && c != ',', "invalid destination", destination);
    }
    return kj::str("Destination: ", basePath, destination);
  }

  kj::String makeOverwriteHeader(bool noOverwrite) {
    return noOverwrite ? kj::heapString("Overwrite: F")
                       : kj::heapString("Overwrite: T");
  }

  kj::String makeDepthHeader(bool shallow) {
    return shallow ? kj::heapString("Depth: 0")
                   : kj::heapString("Depth: infinity");
  }
};

WebSession::Client newPowerboxApiSession(
    kj::NetworkAddress& serverAddress, BridgeContext& bridgeContext,
    OwnCapnp<BridgeObjectId::HttpApi>&& httpApi) {
  // We need to fetch the user's profile information.
  //
  // TODO(someday): The restore() method should be extended to take profile information as a
  //   parameter, passed from Sandstorm. The profile information should allow for representing
  //   the client grain as if it were an identity, so that when one grain changes another through
  //   an API, the changes are attributed to the calling grain, not to the user who connected the
  //   grains. (Of course, the "who has access" tree can indicate who gave that grain
  //   permission.)
  auto identity = bridgeContext.loadIdentity(textIdentityId(httpApi.getIdentityId()));
  auto profileRequest = identity.getProfileRequest().send();
  auto pictureRequest = profileRequest.getProfile().getPicture().getUrlRequest().send();

  return profileRequest
      .then([&serverAddress,&bridgeContext,KJ_MVCAP(httpApi),
             KJ_MVCAP(pictureRequest),KJ_MVCAP(identity)](
          capnp::Response<Identity::GetProfileResults> profileResponse) mutable {
    return pictureRequest.then([&serverAddress,&bridgeContext,KJ_MVCAP(httpApi),
                                KJ_MVCAP(profileResponse),KJ_MVCAP(identity)](
        capnp::Response<StaticAsset::GetUrlResults> pictureResponse) mutable {
      auto profile = profileResponse.getProfile();
      capnp::MallocMessageBuilder userInfoBuilder;
      auto userInfo = userInfoBuilder.getRoot<UserInfo>();
      userInfo.setDisplayName(profile.getDisplayName());
      userInfo.setPreferredHandle(profile.getPreferredHandle());
      userInfo.setPictureUrl(
          kj::str(pictureResponse.getProtocol(), "://", pictureResponse.getHostPath()));
      userInfo.setPronouns(profile.getPronouns());
      userInfo.setPermissions(httpApi.getPermissions());
      userInfo.setIdentityId(httpApi.getIdentityId());
      userInfo.setIdentity(kj::mv(identity));

      auto msg = capnp::MallocMessageBuilder();
      auto sessionInfo = msg.initRoot<SessionInfo>();
      sessionInfo.setNormal();

      return WebSession::Client(
          kj::heap<WebSessionImpl>(serverAddress, userInfo, nullptr,
                                   bridgeContext, nullptr, nullptr,
                                   nullptr, nullptr, nullptr,
                                   kj::str(httpApi.getPath(), '/'),
                                   bridgeContext.formatPermissions(httpApi.getPermissions()),
                                   nullptr, kj::mv(httpApi),
                                   sessionInfo));
    });
  });
}

class EmailSessionImpl final: public HackEmailSession::Server {
public:
  kj::Promise<void> send(SendContext context) override {
    // We're receiving an e-mail. We place the message in maildir format under /var/mail.

    auto email = context.getParams().getEmail();
    auto id = genRandomString();

    // TODO(perf): The following does a lot more copying than necessary.

    // Construct the mail file.
    kj::Vector<kj::String> lines;

    addDateHeader(lines, email.getDate());

    addHeader(lines, "To", email.getTo());
    addHeader(lines, "From", email.getFrom());
    addHeader(lines, "Reply-To", email.getReplyTo());
    addHeader(lines, "CC", email.getCc());
    addHeader(lines, "BCC", email.getBcc());
    addHeader(lines, "Subject", email.getSubject());

    addHeader(lines, "Message-Id", email.getMessageId());
    addHeader(lines, "References", email.getReferences());
    addHeader(lines, "In-Reply-To", email.getInReplyTo());

    addHeader(lines, "Content-Type",
        kj::str("multipart/alternative; boundary=", id));

    lines.add(nullptr);  // blank line starts body.

    if (email.hasText()) {
      lines.add(kj::str("--", id));
      addHeader(lines, "Content-Type", kj::str("text/plain; charset=UTF-8"));
      lines.add(nullptr);
      lines.add(kj::str(email.getText()));
    }
    if (email.hasHtml()) {
      lines.add(kj::str("--", id));
      addHeader(lines, "Content-Type", kj::str("text/html; charset=UTF-8"));
      lines.add(nullptr);
      lines.add(kj::str(email.getHtml()));
    }
    for (auto attachment : email.getAttachments()) {
      addAttachment(lines, id, attachment);
    }
    lines.add(kj::str("--", id, "--"));

    lines.add(nullptr);
    auto text = kj::strArray(lines, "\n");

    // Write to temp file. Prefix name with _ in case `id` starts with '.'.
    auto tmpFilename = kj::str("/var/mail/tmp/_", id);
    auto mailFd = raiiOpen(tmpFilename, O_WRONLY | O_CREAT | O_EXCL);
    kj::FdOutputStream((int)mailFd).write(text.begin(), text.size());
    mailFd = nullptr;

    // Move to final location.
    KJ_SYSCALL(rename(tmpFilename.cStr(), kj::str("/var/mail/new/_", id).cStr()));

    return kj::READY_NOW;
  }

private:
  static kj::String genRandomString() {
    // Generate a unique random string.

    // Get 16 random bytes.
    kj::byte bytes[16];
    kj::FdInputStream(raiiOpen("/dev/urandom", O_RDONLY)).read(bytes, sizeof(bytes));

    // Base64 encode, using digits safe for MIME boundary or a filename.
    static const char DIGITS[65] =
        "0123456789"
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "abcdefghijklmnopqrstuvwxyz_.";
    uint buffer = 0;
    uint bufBits = 0;
    auto chars = kj::heapArrayBuilder<char>(23);
    for (kj::byte b: bytes) {
      buffer |= b << bufBits;
      bufBits += 8;

      while (bufBits >= 6) {
        chars.add(DIGITS[buffer & 63]);
        buffer >>= 6;
        bufBits -= 6;
      }
    }
    chars.add(DIGITS[buffer & 63]);
    chars.add('\0');

    return kj::String(chars.finish());
  }

  static void addHeader(kj::Vector<kj::String>& lines, kj::StringPtr name, kj::StringPtr value) {
    if (value.size() > 0) {
      lines.add(kj::str(name, ": ", value));
    }
  }

  static kj::String formatAddress(EmailAddress::Reader email) {
    auto name = email.getName();
    auto address = email.getAddress();
    if (name.size() == 0) {
      return kj::str(address);
    } else {
      return kj::str(name, " <", address, ">");
    }
  }

  static void addHeader(kj::Vector<kj::String>& lines, kj::StringPtr name,
                        EmailAddress::Reader email) {
    addHeader(lines, name, formatAddress(email));
  }

  static void addHeader(kj::Vector<kj::String>& lines, kj::StringPtr name,
                        capnp::List<EmailAddress>::Reader emails) {
    addHeader(lines, name, kj::strArray(KJ_MAP(e, emails) { return formatAddress(e); }, ", "));
  }

  static void addHeader(kj::Vector<kj::String>& lines, kj::StringPtr name,
                        capnp::List<capnp::Text>::Reader items) {
    // Used for lists of message IDs (e.g. References an In-Reply-To). Each ID should be "quoted"
    // with <>.
    addHeader(lines, name, kj::strArray(KJ_MAP(i, items) { return kj::str('<', i, '>'); }, " "));
  }

  static void addDateHeader(kj::Vector<kj::String>& lines, int64_t nanoseconds) {
    time_t seconds(nanoseconds / 1000000000u);
    struct tm *tm = gmtime(&seconds);
    char date[40];
    strftime(date, sizeof(date), "%a, %d %b %Y %H:%M:%S %z", tm);

    addHeader(lines, "Date", date);
  }

  static void addAttachment(kj::Vector<kj::String>& lines, kj::StringPtr boundaryId, EmailAttachment::Reader & attachment) {
    lines.add(kj::str("--", boundaryId));
    addHeader(lines, "Content-Type", attachment.getContentType());
    addHeader(lines, "Content-Disposition", attachment.getContentDisposition());
    addHeader(lines, "Content-Transfer-Encoding", "base64");
    addHeader(lines, "Content-Id", attachment.getContentId());
    lines.add(nullptr);

    lines.add(kj::encodeBase64(attachment.getContent(), true));
  }
};

class RequestSessionImpl final: public WebSession::Server {
public:
  RequestSessionImpl(kj::NetworkAddress& serverAddress, BridgeContext& bridgeContext,
                     SessionContext::Client sessionContext,
                     kj::Array<byte>&& identityId, kj::Array<bool>&& permissions)
      : serverAddress(serverAddress),
        bridgeContext(bridgeContext),
        sessionContext(kj::mv(sessionContext)),
        identityId(kj::mv(identityId)),
        permissions(kj::mv(permissions)) {
    // Find where we're supposed to inject the config blob into the HTML.
    kj::StringPtr html = *BRIDGE_REQUEST_SESSION_HTML;

    static char MARKER[] = "@CONFIG@";
    const char* configPos = strstr(html.begin(), MARKER);
    KJ_ASSERT(configPos != nullptr);

    prefix = html.slice(0, configPos - html.begin());
    suffix = html.slice(configPos - html.begin() + strlen(MARKER), html.size());
  }

  kj::Promise<void> get(GetContext context) override {
    auto params = context.getParams();
    auto path = params.getPath();
    auto results = context.getResults();

    if (path == "") {
      // Determine the subset of PowerboxApis which the user has permission to choose.
      //
      // TODO(soon): Also match against descriptors.
      kj::Vector<spk::BridgeConfig::PowerboxApi::Reader> apis;
      for (auto api: bridgeContext.getPowerboxApis()) {
        bool requirementsMet = true;

        if (api.hasPermissions()) {
          auto requiredPermissions = api.getPermissions();
          for (size_t i: kj::indices(requiredPermissions)) {
            if (requiredPermissions[i]) {
              if (permissions.size() <= i || !permissions[i]) {
                requirementsMet = false;
                break;
              }
            }
          }
        }

        if (requirementsMet) {
          apis.add(api);
        }
      }

      // JSON-ify that list as the config blob.
      capnp::MallocMessageBuilder filteredConfig;
      auto list = filteredConfig.getRoot<spk::BridgeConfig>().initPowerboxApis(apis.size());
      for (size_t i: kj::indices(apis)) {
        list.setWithCaveats(i, apis[i]);
      }

      capnp::JsonCodec codec;
      auto config = codec.encode(list);

      // Send back our static HTML with the config blob injected into it.
      auto content = results.initContent();
      content.setMimeType("text/html; charset=UTF-8");
      auto body = content.initBody().initBytes(prefix.size() + config.size() + suffix.size());
      memcpy(body.begin(), prefix.begin(), prefix.size());
      memcpy(body.begin() + prefix.size(), config.begin(), config.size());
      memcpy(body.begin() + prefix.size() + config.size(), suffix.begin(), suffix.size());
      return kj::READY_NOW;
    } else {
      auto error = results.initClientError();
      error.setStatusCode(WebSession::Response::ClientErrorCode::NOT_FOUND);
      error.setDescriptionHtml("404 not found");
      return kj::READY_NOW;
    }
  }

  kj::Promise<void> post(PostContext context) override {
    auto params = context.getParams();
    auto path = params.getPath();
    auto results = context.getResults();

    if (path == "") {
      auto name = kj::str(params.getContent().getContent().asChars());

      for (auto api: bridgeContext.getPowerboxApis()) {
        if (api.getName() == name) {
          auto req = sessionContext.fulfillRequestRequest();

          auto tag = req.initDescriptor().initTags(1)[0];
          tag.setId(capnp::typeId<ApiSession>());
          tag.initValue().setAs<ApiSession::PowerboxTag>(api.getTag());

          req.setRequiredPermissions(api.getPermissions());
          req.setDisplayInfo(api.getDisplayInfo());

          capnp::MallocMessageBuilder message(32);
          auto httpApi = message.getRoot<BridgeObjectId::HttpApi>();
          httpApi.setIdentityId(identityId);
          httpApi.setName(name);
          httpApi.setPath(api.getPath());
          httpApi.setPermissions(api.getPermissions());

          req.setCap(newPowerboxApiSession(serverAddress, bridgeContext,
              newOwnCapnp(httpApi.asReader())));

          results.initNoContent();
          return req.send().ignoreResult();
        }
      }

      KJ_FAIL_REQUIRE("unknown API", name);

    } else {
      auto error = results.initClientError();
      error.setStatusCode(WebSession::Response::ClientErrorCode::NOT_FOUND);
      error.setDescriptionHtml("404 not found");
      return kj::READY_NOW;
    }
  }

private:
  kj::NetworkAddress& serverAddress;
  BridgeContext& bridgeContext;
  SessionContext::Client sessionContext;
  kj::Array<byte> identityId;
  kj::Array<bool> permissions;

  kj::ArrayPtr<const char> prefix;
  kj::ArrayPtr<const char> suffix;
};

class SandstormHttpBridgeImpl final: public SandstormHttpBridge::Server {
public:
  explicit SandstormHttpBridgeImpl(SandstormApi<BridgeObjectId>::Client&& apiCap,
                                   BridgeContext& bridgeContext)
      : apiCap(kj::mv(apiCap)),
        bridgeContext(bridgeContext) {}

  kj::Promise<void> getSandstormApi(GetSandstormApiContext context) override {
    context.getResults().setApi(apiCap.castAs<SandstormApi<>>());
    return kj::READY_NOW;
  }

  kj::Promise<void> getSessionContext(GetSessionContextContext context) override {
    auto id = context.getParams().getId();
    KJ_IF_MAYBE(value, bridgeContext.findSessionContext(id)) {
      context.getResults().setContext(*value);
    } else {
      KJ_FAIL_ASSERT("Session ID not found", id);
    }
    return kj::READY_NOW;
  }

  kj::Promise<void> getSessionOffer(GetSessionOfferContext context) override {
    auto id = context.getParams().getId();
    KJ_IF_MAYBE(sessionInfo, bridgeContext.findSessionInfo(id)) {
      switch(sessionInfo->which()) {
        case SessionInfo::OFFER:
          {
            auto offerInfo = sessionInfo->getOffer();
            auto results = context.initResults();
            results.setOffer(offerInfo.getOffer());
            results.setDescriptor(offerInfo.getDescriptor());
          }
          break;
        default:
          KJ_FAIL_ASSERT("Session ID ", id, " is not an offer session.");
      }
    } else {
      KJ_FAIL_ASSERT("Session ID ", id, " not found");
    }
    return kj::READY_NOW;
  }

  kj::Promise<void> getSessionRequest(GetSessionRequestContext context) override {
    auto id = context.getParams().getId();
    KJ_IF_MAYBE(sessionInfo, bridgeContext.findSessionInfo(id)) {
      switch(sessionInfo->which()) {
        case SessionInfo::REQUEST:
          context
            .initResults()
            .setRequestInfo(sessionInfo->getRequest().getRequestInfo());
          break;
        default:
          KJ_FAIL_ASSERT("Session ID ", id, " is not a request session.");
      }
    } else {
      KJ_FAIL_ASSERT("Session ID ", id, " not found");
    }
    return kj::READY_NOW;
  }

  kj::Promise<void> getSavedIdentity(GetSavedIdentityContext context) override {
    context.getResults().setIdentity(
        bridgeContext.loadIdentity(context.getParams().getIdentityId()));
    return kj::READY_NOW;
  }

  kj::Promise<void> saveIdentity(SaveIdentityContext context) override {
    auto identity = context.getParams().getIdentity();
    context.releaseParams();
    auto request = apiCap.getIdentityIdRequest();
    request.setIdentity(identity);
    return request.send().then([this, KJ_MVCAP(identity)](auto response) mutable -> void {
      bridgeContext.saveIdentity(response.getId(), kj::mv(identity));
    });
  }

private:
  SandstormApi<BridgeObjectId>::Client apiCap;
  BridgeContext& bridgeContext;
};

class UiViewImpl final: public MainView<BridgeObjectId>::Server {
public:
  explicit UiViewImpl(kj::NetworkAddress& serverAddress,
                      BridgeContext& bridgeContext,
                      spk::BridgeConfig::Reader config,
                      kj::Promise<void>&& connectPromise,
                      kj::Maybe<kj::Own<kj::Promise<AppHooks<>::Client>>> appHooksPromise)
      : serverAddress(serverAddress),
        bridgeContext(bridgeContext),
        config(config),
        connectPromise(connectPromise.fork()),
        appHooks(nullptr) {
          KJ_IF_MAYBE(promise, appHooksPromise) {
            appHooks = kj::heap((*promise)->fork());
          }
        }

  kj::Promise<void> getViewInfo(GetViewInfoContext context) override {
    KJ_IF_MAYBE(promise, appHooks) {
      return (*promise)->addBranch().then([this, context](auto appHooks) -> kj::Promise<void> {
        return appHooks.getViewInfoRequest().send()
          .then([context](auto results) mutable -> kj::Promise<void> {
            context.setResults(results);
            return kj::READY_NOW;
          }, [this, context](kj::Exception&& e) -> kj::Promise<void> {
            if(e.getType() == kj::Exception::Type::UNIMPLEMENTED) {
              return getViewInfoFromConfig(context);
            } else {
              throw kj::mv(e);
            }
          });
      });
    } else {
      return getViewInfoFromConfig(context);
    }
  }

  kj::Promise<void> getViewInfoFromConfig(GetViewInfoContext context) {
    context.setResults(config.getViewInfo());

    // Copy in powerbox API descriptors.
    auto apis = config.getPowerboxApis();
    if (apis.size() > 0) {
      auto viewInfo = context.getResults();
      auto descriptors = viewInfo.initMatchRequests(apis.size());
      for (size_t i: kj::indices(apis)) {
        auto tag = descriptors[i].initTags(1)[0];
        tag.setId(capnp::typeId<ApiSession>());
        tag.getValue().setAs<ApiSession::PowerboxTag>(apis[i].getTag());
      }
    }

    return kj::READY_NOW;
  }

  UiSession::Client newUiSession(
        UserInfo::Reader userInfo,
        kj::String&& sessionId,
        WebSession::Params::Reader sessionParams,
        SessionContext::Client sessionCtx,
        kj::ArrayPtr<const kj::byte> tabId,
        SessionInfo::Reader sessionInfo) {

    auto userPermissions = userInfo.getPermissions();
    return
      kj::heap<WebSessionImpl>(serverAddress, userInfo, sessionCtx,
                               bridgeContext, kj::str(sessionId),
                               kj::encodeHex(tabId),
                               kj::heapString(sessionParams.getBasePath()),
                               kj::heapString(sessionParams.getUserAgent()),
                               kj::strArray(sessionParams.getAcceptableLanguages(), ","),
                               kj::heapString("/"),
                               bridgeContext.formatPermissions(userPermissions),
                               nullptr, nullptr,
                               sessionInfo);

  }

  kj::Promise<void> newSession(NewSessionContext context) override {
    auto params = context.getParams();
    auto sessionType = params.getSessionType();

    KJ_REQUIRE(sessionType == capnp::typeId<WebSession>() ||
               sessionType == capnp::typeId<HackEmailSession>() ||
               (config.getApiPath().size() > 0 && sessionType == capnp::typeId<ApiSession>()),
               "Unsupported session type.");

    auto userInfo = params.getUserInfo();
    if (userInfo.hasIdentity() && config.getSaveIdentityCaps()) {
      bridgeContext.saveIdentity(userInfo.getIdentityId(), userInfo.getIdentity());
    }

    if (sessionType == capnp::typeId<WebSession>()) {
      auto sessionParams = params.getSessionParams().getAs<WebSession::Params>();

      auto msg = capnp::MallocMessageBuilder();
      auto sessionInfo = msg.initRoot<SessionInfo>();
      sessionInfo.setNormal();

      UiSession::Client session =
        newUiSession(
            userInfo,
            kj::str(sessionIdCounter++),
            sessionParams,
            params.getContext(),
            params.getTabId(),
            sessionInfo);

      context.getResults(capnp::MessageSize {2, 1}).setSession(
        connectPromise.addBranch().then([KJ_MVCAP(session)]() mutable {
          return kj::mv(session);
        }));
    } else if (sessionType == capnp::typeId<ApiSession>()) {
      auto userPermissions = userInfo.getPermissions();
      auto sessionParams = params.getSessionParams().getAs<ApiSession::Params>();
      kj::Maybe<kj::String> addr = nullptr;
      if (sessionParams.hasRemoteAddress()) {
        addr = addressToString(sessionParams.getRemoteAddress());
      }

      auto msg = capnp::MallocMessageBuilder();
      auto sessionInfo = msg.initRoot<SessionInfo>();
      sessionInfo.setNormal();
      UiSession::Client session =
        kj::heap<WebSessionImpl>(serverAddress, userInfo, params.getContext(),
                                 bridgeContext, kj::str(sessionIdCounter++),
                                 kj::encodeHex(params.getTabId()),
                                 kj::heapString(""), kj::heapString(""), kj::heapString(""),
                                 kj::heapString(config.getApiPath()),
                                 bridgeContext.formatPermissions(userPermissions),
                                 kj::mv(addr), nullptr,
                                 sessionInfo);

      context.getResults(capnp::MessageSize {2, 1}).setSession(
        connectPromise.addBranch().then([KJ_MVCAP(session)]() mutable {
          return kj::mv(session);
        }));
    } else if (sessionType == capnp::typeId<HackEmailSession>()) {
      context.getResults(capnp::MessageSize {2, 1}).setSession(kj::heap<EmailSessionImpl>());
    }

    return kj::READY_NOW;
  }

  kj::Promise<void> newRequestSession(NewRequestSessionContext context) override {
    auto params = context.getParams();

    KJ_REQUIRE(params.getSessionType() == capnp::typeId<WebSession>(),
               "Unsupported request session type.");

    auto userInfo = params.getUserInfo();
    if (userInfo.hasIdentity() && config.getSaveIdentityCaps()) {
      bridgeContext.saveIdentity(userInfo.getIdentityId(), userInfo.getIdentity());
    }

    auto permissions = kj::heapArrayFromIterable<bool>(userInfo.getPermissions());

    auto requestInfo = params.getRequestInfo();
    bool allApiSession = true;
    for(const auto& desc : requestInfo) {
      for(const auto& tag : desc.getTags()) {
        if(tag.getId() != capnp::typeId<ApiSession>()) {
          allApiSession = false;
          break;
        }
      }
    }

    if(allApiSession) {
      // All of the tags are of type ApiSession; handle the request ourselves.
      UiSession::Client session =
          kj::heap<RequestSessionImpl>(
              serverAddress, bridgeContext, params.getContext(),
              kj::heapArray(userInfo.getIdentityId()), kj::mv(permissions));

      context.getResults(capnp::MessageSize {2, 1}).setSession(
          connectPromise.addBranch().then([KJ_MVCAP(session)]() mutable {
            return kj::mv(session);
          }));
    } else {
      // At least one tag is something other than ApiSession; let the app handle
      // the request.
      auto sessionId = kj::str(sessionIdCounter++);

      auto sessionParams = params.getSessionParams().getAs<WebSession::Params>();

      auto msg = capnp::MallocMessageBuilder();
      auto sessionInfo = msg.initRoot<SessionInfo>();
      sessionInfo.initRequest().setRequestInfo(requestInfo);

      UiSession::Client session =
        newUiSession(
            userInfo,
            kj::str(sessionIdCounter++),
            sessionParams,
            params.getContext(),
            params.getTabId(),
            sessionInfo);

      context.getResults(capnp::MessageSize {2, 1}).setSession(
          connectPromise.addBranch().then([KJ_MVCAP(session)]() mutable {
            return kj::mv(session);
          }));
    }
    return kj::READY_NOW;
  }

  kj::Promise<void> newOfferSession(NewOfferSessionContext context) override {
    auto params = context.getParams();
    auto sessionId = kj::str(sessionIdCounter++);
    auto userInfo = params.getUserInfo();
    auto sessionParams = params.getSessionParams().getAs<WebSession::Params>();

    auto msg = capnp::MallocMessageBuilder();
    auto sessionInfo = msg.initRoot<SessionInfo>();
    auto offerInfo = sessionInfo.initOffer();
    offerInfo.setOffer(params.getOffer());
    offerInfo.setDescriptor(params.getDescriptor());

    UiSession::Client session =
      newUiSession(
          userInfo,
          kj::str(sessionId),
          sessionParams,
          params.getContext(),
          params.getTabId(),
          sessionInfo);

    context.getResults(capnp::MessageSize {2, 1}).setSession(
      connectPromise.addBranch().then([KJ_MVCAP(session)]() mutable {
        return kj::mv(session);
      }));

    return kj::READY_NOW;
  }

  kj::Promise<void> restore(RestoreContext context) override {
    auto objectId = context.getParams().getObjectId();

    if (objectId.isApplication()) {
      KJ_IF_MAYBE(promise, appHooks) {
        return (*promise)->addBranch().then([context, objectId](auto appHooks) -> kj::Promise<void> {
            auto req = appHooks.restoreRequest();
            req.setObjectId(objectId.getApplication());
            return req.send().then([context](auto results) mutable -> kj::Promise<void> {
                context.initResults().setCap(results.getCap());
                return kj::READY_NOW;
            });
        });
      } else {
        KJ_FAIL_REQUIRE(
            "restore() got an objectId with type = application, but "
            "expectAppHooks is false."
            );
      }
    }

    KJ_REQUIRE(objectId.isHttpApi(), "unrecognized object ID type");

    context.getResults().setCap(
        newPowerboxApiSession(serverAddress, bridgeContext, newOwnCapnp(objectId.getHttpApi())));
    return kj::READY_NOW;
  }

  kj::Promise<void> drop(DropContext context) override {
    auto objectId = context.getParams().getObjectId();
    if (!objectId.isApplication()) {
      // We ignore drops for our own capabilities, because our ObjectId format
      // is too ambiguous for it to be useful.
      return kj::READY_NOW;
    }
    KJ_IF_MAYBE(promise, appHooks) {
      return (*promise)->addBranch().then([objectId](auto appHooks) -> kj::Promise<void> {
          auto req = appHooks.dropRequest();
          req.setObjectId(objectId.getApplication());
          return req.send().ignoreResult();
      });
    } else {
      KJ_FAIL_REQUIRE(
          "drop() got an objectId with type = application, but "
          "expectAppHooks is false."
          );
    }
  }

private:
  inline kj::String addressToString(::sandstorm::IpAddress::Reader&& address) {
    uint64_t lower64 = address.getLower64();
    uint64_t upper64 = address.getUpper64();
    if (upper64 == 0 && ((lower64 >> 32) == 0xffff)) {
      // This is an IPv4 address.
      char buf[INET_ADDRSTRLEN];
      memset(buf, 0, INET_ADDRSTRLEN);
      lower64 &= 0xffffffff;
      struct in_addr ipv4;
      ipv4.s_addr = ntohl(uint32_t(lower64));
      const char* ok = inet_ntop(AF_INET, &ipv4, buf, INET_ADDRSTRLEN);
      KJ_REQUIRE(ok != nullptr, "inet_ntop() failed");
      kj::String s = kj::heapString(buf);
      return kj::mv(s);
    } else {
      // This is an IPv6 address.
      char buf[INET6_ADDRSTRLEN];
      memset(buf, 0, INET6_ADDRSTRLEN);
      struct in6_addr ipv6;
      ipv6.s6_addr[0]  = ((upper64 >> 56) & 0xff);
      ipv6.s6_addr[1]  = ((upper64 >> 48) & 0xff);
      ipv6.s6_addr[2]  = ((upper64 >> 40) & 0xff);
      ipv6.s6_addr[3]  = ((upper64 >> 32) & 0xff);
      ipv6.s6_addr[4]  = ((upper64 >> 24) & 0xff);
      ipv6.s6_addr[5]  = ((upper64 >> 16) & 0xff);
      ipv6.s6_addr[6]  = ((upper64 >>  8) & 0xff);
      ipv6.s6_addr[7]  = ((upper64      ) & 0xff);
      ipv6.s6_addr[8]  = ((lower64 >> 56) & 0xff);
      ipv6.s6_addr[9]  = ((lower64 >> 48) & 0xff);
      ipv6.s6_addr[10] = ((lower64 >> 40) & 0xff);
      ipv6.s6_addr[11] = ((lower64 >> 32) & 0xff);
      ipv6.s6_addr[12] = ((lower64 >> 24) & 0xff);
      ipv6.s6_addr[13] = ((lower64 >> 16) & 0xff);
      ipv6.s6_addr[14] = ((lower64 >>  8) & 0xff);
      ipv6.s6_addr[15] = ((lower64      ) & 0xff);
      const char* ok = inet_ntop(AF_INET6, &ipv6, buf, INET6_ADDRSTRLEN);
      KJ_REQUIRE(ok != nullptr, "inet_ntop() failed");
      kj::String s = kj::heapString(buf);
      return kj::mv(s);
    }
  }

  kj::NetworkAddress& serverAddress;
  BridgeContext& bridgeContext;
  spk::BridgeConfig::Reader config;

  kj::ForkedPromise<void> connectPromise;
  // A promise that resolves once we have successfully connected to the app. Only after
  // this resolves do we attempt to forward any incoming HTTP requests to the app.

  uint sessionIdCounter = 0;
  // SessionIds are assigned sequentially.
  // TODO(security): It might be useful to make these sessionIds more random, to reduce the chance
  //   that an app will mix them up.

  kj::Maybe<kj::Own<kj::ForkedPromise<AppHooks<>::Client>>> appHooks;
};

class SandstormHttpBridgeMain {
  // Main class for the Sandstorm HTTP bridge. This program is meant to run inside an
  // application sandbox where it translates incoming requests back from HTTP-over-RPC to regular
  // HTTP.  This is a shim meant to make it easy to port existing web frameworks into Sandstorm,
  // but long-term apps should seek to drop this binary and instead speak Cap'n Proto directly.
  // It is up to the app to include this binary in their package if they want it.

public:
  SandstormHttpBridgeMain(kj::ProcessContext& context)
      : context(context),
        ioContext(kj::setupAsyncIo()),
        appMembranePolicy(kj::refcounted<SaveMembranePolicy>()),
        appHooksFulfiller(nullptr) {
    kj::UnixEventPort::captureSignal(SIGCHLD);
  }

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Acts as a Sandstorm init application.  Runs <command>, then tries to "
                           "connect to it as an HTTP server at the given address (typically, "
                           "'127.0.0.1:<port>') in order to handle incoming requests.")
        .expectArg("<port>", KJ_BIND_METHOD(*this, setPort))
        .expectOneOrMoreArgs("<command>", KJ_BIND_METHOD(*this, addCommandArg))
        .callAfterParsing(KJ_BIND_METHOD(*this, run))
        .build();
  }

  kj::MainBuilder::Validity setPort(kj::StringPtr port) {
    return ioContext.provider->getNetwork().parseAddress(kj::str("127.0.0.1:", port))
        .then([this](kj::Own<kj::NetworkAddress>&& parsedAddr) -> kj::MainBuilder::Validity {
      this->address = kj::mv(parsedAddr);
      return true;
    }, [](kj::Exception&& e) -> kj::MainBuilder::Validity {
      return "invalid port";
    }).wait(ioContext.waitScope);
  }

  kj::MainBuilder::Validity addCommandArg(kj::StringPtr arg) {
    command.add(kj::heapString(arg));
    return true;
  }

  struct AcceptedConnection {
    kj::Own<kj::AsyncIoStream> connection;
    capnp::TwoPartyVatNetwork network;
    capnp::RpcSystem<capnp::rpc::twoparty::VatId> rpcSystem;

    explicit AcceptedConnection(SandstormHttpBridge::Client bridge,
                                kj::Own<kj::AsyncIoStream>&& connectionParam)
      : connection(kj::mv(connectionParam)),
        network(*connection, capnp::rpc::twoparty::Side::SERVER),
        rpcSystem(capnp::makeRpcServer(network, bridge)) {}
  };

  kj::Promise<void> acceptLoop(kj::ConnectionReceiver& serverPort,
                               SandstormHttpBridge::Client bridge,
                               kj::TaskSet& taskSet) {
    return serverPort.accept().then(
        [&, KJ_MVCAP(bridge)](kj::Own<kj::AsyncIoStream>&& connection) mutable {
      auto connectionState = kj::heap<AcceptedConnection>(
          capnp::reverseMembrane(bridge, appMembranePolicy->addRef()),
          kj::mv(connection));

      KJ_IF_MAYBE(fulfiller, appHooksFulfiller) {
        capnp::MallocMessageBuilder message;
        auto vatId = message.initRoot<capnp::rpc::twoparty::VatId>();
        vatId.setSide(capnp::rpc::twoparty::Side::CLIENT);
        (*fulfiller)->fulfill(
          capnp::membrane(
            connectionState->rpcSystem.bootstrap(vatId),
            appMembranePolicy->addRef()
          ).castAs<AppHooks<>>()
        );
        fulfiller = nullptr;
      }

      auto promise = connectionState->network.onDisconnect();
      taskSet.add(promise.attach(kj::mv(connectionState)));
      return acceptLoop(serverPort, kj::mv(bridge), taskSet);
    });
  }

  kj::Promise<void> connectLoop(kj::Own<kj::NetworkAddress>&& address,
                                kj::Timer& timer,
                                bool loggedSlowStartupMessage,
                                int numTriesSoFar) {
    return address->connect().then([loggedSlowStartupMessage](auto x) -> void {
      if (loggedSlowStartupMessage) {
        KJ_LOG(WARNING, "App successfully started listening for TCP connections!");
      }
    }).catch_(
        [KJ_MVCAP(address), &timer, loggedSlowStartupMessage, numTriesSoFar, this]
        (kj::Exception&& e) mutable {
      if (!loggedSlowStartupMessage) {
        numTriesSoFar++;
      }
      if (!loggedSlowStartupMessage && numTriesSoFar == (30 * 100)) {
        // After 30 seconds (30 * 100 centiseconds) of failure, log a message once.
        KJ_LOG(WARNING, "App isn't listening for TCP connections after 30 seconds. Continuing "
               "to attempt to connect",
               address->toString());
        loggedSlowStartupMessage = true;
      }
      // Wait 10ms and try again.
      return timer.afterDelay(10 * kj::MILLISECONDS).then(
          [KJ_MVCAP(address), &timer, loggedSlowStartupMessage, numTriesSoFar, this]
          () mutable -> kj::Promise<void> {
        return connectLoop(kj::mv(address), timer,
                           loggedSlowStartupMessage, numTriesSoFar);
      });
    });
  }

  class ErrorHandlerImpl: public kj::TaskSet::ErrorHandler {
  public:
    void taskFailed(kj::Exception&& exception) override {
      KJ_LOG(ERROR, "connection failed", exception);
    }
  };

  kj::MainBuilder::Validity run() {
    static constexpr uint PROXY_PORT = 15239;  // random; hopefully doesn't conflict with anything

    auto proxyEnv = kj::str("http://127.0.0.1:", PROXY_PORT, "/");
    KJ_SYSCALL(setenv("http_proxy", proxyEnv.cStr(), true));
    KJ_SYSCALL(setenv("HTTP_PROXY", proxyEnv.cStr(), true));
    KJ_SYSCALL(setenv("no_proxy", "localhost,127.0.0.1", true));

    pid_t child;
    KJ_SYSCALL(child = fork());
    if (child == 0) {
      // We're in the child.
      close(3);  // Close Supervisor's Cap'n Proto socket to avoid confusion.

      // Clear signal mask and reset signal disposition.
      // TODO(cleanup): This is kind of dependent on implementation details of kj/async-unix.c++,
      //   especially the part about SIGPIPE. It belongs in the KJ library.
      sigset_t sigset;
      KJ_SYSCALL(sigemptyset(&sigset));
      KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigset, nullptr));
      if (signal(SIGPIPE, SIG_DFL) == SIG_ERR) {
        KJ_FAIL_SYSCALL("signal(SIGPIPE, SIG_DFL)", errno);
      }

      char* argv[command.size() + 1];
      for (uint i: kj::indices(command)) {
        argv[i] = const_cast<char*>(command[i].cStr());
      }
      argv[command.size()] = nullptr;

      char** argvp = argv;  // work-around Clang not liking lambda + vararray

      KJ_SYSCALL(execvp(argvp[0], argvp), argvp[0]);
      KJ_UNREACHABLE;
    } else {
      // We're in the parent.

      auto exitPromise = onChildExit(child).then([this](int status) {
        KJ_ASSERT(WIFEXITED(status) || WIFSIGNALED(status));
        if (WIFSIGNALED(status)) {
          context.exitError(kj::str(
              "** HTTP-BRIDGE: App server exited due to signal ", WTERMSIG(status),
              " (", strsignal(WTERMSIG(status)), ")."));
        } else {
          context.exitError(kj::str(
              "** HTTP-BRIDGE: App server exited with status code: ", WEXITSTATUS(status)));
        }
      }).eagerlyEvaluate([this](kj::Exception&& e) {
        context.exitError(kj::str(
            "** HTTP-BRIDGE: Uncaught exception waiting for child process:\n", e));
      });

      auto connectPromise =
        connectLoop(address->clone(), ioContext.provider->getTimer(), false, 0);

      // We potentially re-traverse the BridgeConfig on every request, so make sure to max out the
      // traversal limit.
      capnp::ReaderOptions options;
      options.traversalLimitInWords = kj::maxValue;
      capnp::StreamFdMessageReader reader(
          raiiOpen("/sandstorm-http-bridge-config", O_RDONLY), options);
      auto config = reader.getRoot<spk::BridgeConfig>();

      auto apiPaf = kj::newPromiseAndFulfiller<SandstormApi<BridgeObjectId>::Client>();
      BridgeContext bridgeContext(kj::mv(apiPaf.promise), config);

      kj::Maybe<kj::Own<kj::Promise<AppHooks<>::Client>>> appHooksPromise = nullptr;

      if(config.getExpectAppHooks()) {
        auto paf = kj::newPromiseAndFulfiller<AppHooks<>::Client>();
        appHooksPromise = kj::heap<kj::Promise<AppHooks<>::Client>>(kj::mv(paf.promise));
        appHooksFulfiller = kj::mv(paf.fulfiller);
      }

      // Set up the Supervisor API socket.
      auto stream = ioContext.lowLevelProvider->wrapSocketFd(3);
      capnp::TwoPartyVatNetwork network(*stream, capnp::rpc::twoparty::Side::CLIENT);
      auto rpcSystem = capnp::makeRpcServer(
        network,
        kj::heap<UiViewImpl>(
          *address,
          bridgeContext,
          config,
          kj::mv(connectPromise),
          kj::mv(appHooksPromise)));

      // Get the SandstormApi by restoring a null SturdyRef.
      capnp::MallocMessageBuilder message;
      auto vatId = message.initRoot<capnp::rpc::twoparty::VatId>();
      vatId.setSide(capnp::rpc::twoparty::Side::SERVER);
      SandstormApi<BridgeObjectId>::Client api = rpcSystem.bootstrap(vatId)
          .castAs<SandstormApi<BridgeObjectId>>();
      apiPaf.fulfiller->fulfill(kj::cp(api));

      // Export a Unix socket on which the application can connect and make calls directly to the
      // Sandstorm API.
      SandstormHttpBridge::Client sandstormHttpBridge =
          kj::heap<SandstormHttpBridgeImpl>(kj::cp(api), bridgeContext);
      ErrorHandlerImpl errorHandler;
      kj::TaskSet tasks(errorHandler);
      unlink("/tmp/sandstorm-api");  // Clear stale socket, if any.
      auto acceptTask = ioContext.provider->getNetwork()
          .parseAddress("unix:/tmp/sandstorm-api", 0)
          .then([&, sandstormHttpBridge](kj::Own<kj::NetworkAddress>&& addr) mutable {
        auto serverPort = addr->listen();
        auto promise = acceptLoop(*serverPort, kj::mv(sandstormHttpBridge), tasks);
        return promise.attach(kj::mv(serverPort));
      });

      // Export an HTTP proxy which the app can use to make HTTP API requests.
      kj::HttpHeaderTable::Builder headerTableBuilder;
      auto bridgeProxy = newBridgeProxy(ioContext.provider->getTimer(),
          api, sandstormHttpBridge, config, headerTableBuilder);
      auto headerTable = headerTableBuilder.build();

      // No need for request timeouts on this proxy. We trust the app.
      kj::HttpServer::Settings settings;
      settings.headerTimeout = 1 * kj::DAYS;
      settings.pipelineTimeout = 1 * kj::DAYS;
      kj::HttpServer server(ioContext.provider->getTimer(), *headerTable, *bridgeProxy, settings);

      auto proxyAddress = ioContext.provider->getNetwork()
          .parseAddress("127.0.0.1", PROXY_PORT).wait(ioContext.waitScope);
      auto proxyListener = proxyAddress->listen();
      auto listenTask = server.listenHttp(*proxyListener)
          .eagerlyEvaluate([this](kj::Exception&& e) {
        context.exitError(kj::str("** HTTP-BRIDGE: Outgoing HTTP proxy died; aborting:\n", e));
      });

      exitPromise.wait(ioContext.waitScope);
      KJ_UNREACHABLE;  // exitPromise always exits before completing
    }
  }

private:
  kj::ProcessContext& context;
  kj::AsyncIoContext ioContext;
  kj::Own<kj::NetworkAddress> address;
  kj::Vector<kj::String> command;
  kj::Own<SaveMembranePolicy> appMembranePolicy;
  kj::Maybe<kj::Own<kj::PromiseFulfiller<AppHooks<>::Client>>> appHooksFulfiller;

  kj::Promise<int> onChildExit(pid_t pid) {
    int status;
    int waitResult;
    KJ_SYSCALL(waitResult = waitpid(pid, &status, WNOHANG));
    if (waitResult == 0) {
      return ioContext.unixEventPort.onSignal(SIGCHLD).then([this,pid](siginfo_t&& info) {
        return onChildExit(pid);
      });
    } else {
      return status;
    }
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::SandstormHttpBridgeMain)
