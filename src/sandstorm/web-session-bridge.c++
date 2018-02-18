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

#include "web-session-bridge.h"
#include <kj/debug.h>
#include <capnp/schema.h>
#include <sodium/randombytes.h>
#include <time.h>
#include <kj/compat/url.h>
#include <kj/compat/gzip.h>

namespace sandstorm {

static HttpStatusDescriptor::Reader getHttpStatusAnnotation(
    capnp::EnumSchema::Enumerant enumerant) {
  for (auto annotation: enumerant.getProto().getAnnotations()) {
    if (annotation.getId() == HTTP_STATUS_ANNOTATION_ID) {
      return annotation.getValue().getStruct().getAs<HttpStatusDescriptor>();
    }
  }
  KJ_FAIL_ASSERT("Missing httpStatus annotation on status code enumerant.",
                 enumerant.getProto().getName());
}

static inline ByteStream::Client newNoStreamingByteStream();

WebSessionBridge::Tables::Tables(kj::HttpHeaderTable::Builder& headerTableBuilder)
    : headerTable(headerTableBuilder.getFutureTable()),
      hAccessControlAllowOrigin(headerTableBuilder.add("Access-Control-Allow-Origin")),
      hAccessControlExposeHeaders(headerTableBuilder.add("Access-Control-Expose-Headers")),
      hAccept(headerTableBuilder.add("Accept")),
      hAcceptEncoding(headerTableBuilder.add("Accept-Encoding")),
      hContentDisposition(headerTableBuilder.add("Content-Disposition")),
      hContentEncoding(headerTableBuilder.add("Content-Encoding")),
      hContentLanguage(headerTableBuilder.add("Content-Language")),
      hContentSecurityPolicy(headerTableBuilder.add("Content-Security-Policy")),
      hCookie(headerTableBuilder.add("Cookie")),
      hETag(headerTableBuilder.add("ETag")),
      hIfMatch(headerTableBuilder.add("If-Match")),
      hIfNoneMatch(headerTableBuilder.add("If-None-Match")),
      hSecWebSocketProtocol(headerTableBuilder.add("Sec-WebSocket-Protocol")),
      hVary(headerTableBuilder.add("Vary")),

      hDav(headerTableBuilder.add("DAV")),
      hDepth(headerTableBuilder.add("Depth")),
      hDestination(headerTableBuilder.add("Destination")),
      hLockToken(headerTableBuilder.add("Lock-Token")),
      hOverwrite(headerTableBuilder.add("Overwrite")),

      successCodeTable(KJ_MAP(enumerant,
            capnp::Schema::from<WebSession::Response::SuccessCode>().getEnumerants()) {
        return getHttpStatusAnnotation(enumerant);
      }),
      errorCodeTable(KJ_MAP(enumerant,
            capnp::Schema::from<WebSession::Response::ClientErrorCode>().getEnumerants()) {
        return getHttpStatusAnnotation(enumerant);
      }),
      requestHeaderWhitelist(*WebSession::Context::HEADER_WHITELIST),
      responseHeaderWhitelist(*WebSession::Response::HEADER_WHITELIST) {}

WebSessionBridge::WebSessionBridge(
    WebSession::Client session, kj::Maybe<Handle::Client> loadingIndicator,
    const Tables& tables, Options options)
    : session(kj::mv(session)),
      loadingIndicator(kj::mv(loadingIndicator)),
      tables(tables),
      options(options) {}

kj::Promise<void> WebSessionBridge::request(
    kj::HttpMethod method, kj::StringPtr path, const kj::HttpHeaders& headers,
    kj::AsyncInputStream& requestBody, Response& response) {
  if (method == kj::HttpMethod::GET && headers.isWebSocket()) {
    return openWebSocket(path, headers, response);
  }

  KJ_REQUIRE(path.startsWith("/"));
  path = path.slice(1);

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
      auto doNonStreaming = [this,method,path,&headers,&requestBody,&response]() {
        return requestBody.readAllBytes()
            .then([this,path,&headers,&response]
                  (kj::Array<byte>&& data) mutable {
          auto req = session.postRequest();
          req.setPath(path);
          auto content = req.initContent();
          content.setContent(data);
          initContent(content, headers);
          auto streamer = initContext(req.initContext(), headers);
          return handleResponse(req.send(), kj::mv(streamer), response);
        });
      };

      KJ_IF_MAYBE(length, requestBody.tryGetLength()) {
        if (*length < MAX_NONSTREAMING_LENGTH) {
          return doNonStreaming();
        }
      }

      // Fall back to streaming.
      auto req = session.postStreamingRequest();
      req.setPath(path);
      initContent(req, headers);
      auto streamer = initContext(req.initContext(), headers);

      // TODO(apibump): Currently we can't pipeline on the stream because we have to handle the
      //   case of old apps which don't support streaming. That fallback should move into the
      //   compat layer, then we can avoid the round-trip here.
      return req.send()
          .then([this,&headers,&requestBody,&response,KJ_MVCAP(streamer)]
                (capnp::Response<WebSession::PostStreamingResults> result) mutable {
        return handleStreamingRequestResponse(
            result.getStream(), requestBody, kj::mv(streamer), response);
      }, [this,KJ_MVCAP(doNonStreaming)](kj::Exception&& e) -> kj::Promise<void> {
        // Unfortunately, some apps are so old that they don't know about UNIMPLEMENTED exceptions,
        // so we have to check the description.
        if (e.getType() == kj::Exception::Type::UNIMPLEMENTED ||
            (e.getType() == kj::Exception::Type::FAILED &&
             strstr(e.getDescription().cStr(), "not implemented") != nullptr)) {
          // OK, fine. Fall back to non-streaming.
          return doNonStreaming();
        }

        return kj::mv(e);
      });
    }

    case kj::HttpMethod::PUT: {
      auto doNonStreaming = [this,method,path,&headers,&requestBody,&response]() {
        return requestBody.readAllBytes()
            .then([this,path,&headers,&response]
                  (kj::Array<byte>&& data) mutable {
          auto req = session.putRequest();
          req.setPath(path);
          auto content = req.initContent();
          content.setContent(data);
          initContent(content, headers);
          auto streamer = initContext(req.initContext(), headers);
          return handleResponse(req.send(), kj::mv(streamer), response);
        });
      };

      KJ_IF_MAYBE(length, requestBody.tryGetLength()) {
        if (*length < MAX_NONSTREAMING_LENGTH) {
          return doNonStreaming();
        }
      }

      // Fall back to streaming.
      auto req = session.putStreamingRequest();
      req.setPath(path);
      initContent(req, headers);
      auto streamer = initContext(req.initContext(), headers);

      // TODO(apibump): Currently we can't pipeline on the stream because we have to handle the
      //   case of old apps which don't support streaming. That fallback should move into the
      //   compat layer, then we can avoid the round-trip here.
      return req.send()
          .then([this,&headers,&requestBody,&response,KJ_MVCAP(streamer)]
                (capnp::Response<WebSession::PutStreamingResults> result) mutable {
        return handleStreamingRequestResponse(
            result.getStream(), requestBody, kj::mv(streamer), response);
      }, [this,KJ_MVCAP(doNonStreaming)](kj::Exception&& e) -> kj::Promise<void> {
        // Unfortunately, some apps are so old that they don't know about UNIMPLEMENTED exceptions,
        // so we have to check the description.
        if (e.getType() == kj::Exception::Type::UNIMPLEMENTED ||
            (e.getType() == kj::Exception::Type::FAILED &&
             strstr(e.getDescription().cStr(), "not implemented") != nullptr)) {
          // OK, fine. Fall back to non-streaming.
          return doNonStreaming();
        }

        return kj::mv(e);
      });
    }

    case kj::HttpMethod::DELETE: {
      auto req = session.deleteRequest();
      req.setPath(path);
      auto streamer = initContext(req.initContext(), headers);
      return handleResponse(req.send(), kj::mv(streamer), response);
    }

    case kj::HttpMethod::PATCH: {
      return requestBody.readAllBytes()
          .then([this,path,&headers,&response]
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

    case kj::HttpMethod::COPY: {
      auto req = session.copyRequest();
      req.setPath(path);
      req.setDestination(davDestination(headers));
      req.setNoOverwrite(davNoOverwrite(headers));
      req.setShallow(davShallow(headers));
      auto streamer = initContext(req.initContext(), headers);
      return handleResponse(req.send(), kj::mv(streamer), response);
    }

    case kj::HttpMethod::LOCK: {
      return davXmlContent(headers, requestBody, response)
          .then([this,path,&headers,&response](kj::Maybe<kj::String> body) -> kj::Promise<void> {
        KJ_IF_MAYBE(b, body) {
          auto req = session.lockRequest();
          req.setPath(path);
          req.setXmlContent(*b);
          req.setShallow(davShallow(headers));
          auto streamer = initContext(req.initContext(), headers);
          return handleResponse(req.send(), kj::mv(streamer), response);
        } else {
          return kj::READY_NOW;
        }
      });
    }

    case kj::HttpMethod::MKCOL: {
      return requestBody.readAllBytes()
          .then([this,path,&headers,&response](kj::Array<byte> data) {
        auto req = session.mkcolRequest();
        req.setPath(path);
        auto content = req.initContent();
        content.setContent(data);
        initContent(content, headers);
        auto streamer = initContext(req.initContext(), headers);
        return handleResponse(req.send(), kj::mv(streamer), response);
      });
    }

    case kj::HttpMethod::MOVE: {
      auto req = session.moveRequest();
      req.setPath(path);
      req.setDestination(davDestination(headers));
      req.setNoOverwrite(davNoOverwrite(headers));
      auto streamer = initContext(req.initContext(), headers);
      return handleResponse(req.send(), kj::mv(streamer), response);
    }

    case kj::HttpMethod::PROPFIND: {
      return davXmlContent(headers, requestBody, response)
          .then([this,path,&headers,&response](kj::Maybe<kj::String> body) -> kj::Promise<void> {
        KJ_IF_MAYBE(b, body) {
          auto req = session.propfindRequest();
          req.setPath(path);
          req.setXmlContent(*b);
          req.setDepth(davPropfindDepth(headers));
          auto streamer = initContext(req.initContext(), headers);
          return handleResponse(req.send(), kj::mv(streamer), response);
        } else {
          return kj::READY_NOW;
        }
      });
    }

    case kj::HttpMethod::PROPPATCH: {
      return davXmlContent(headers, requestBody, response)
          .then([this,path,&headers,&response](kj::Maybe<kj::String> body) -> kj::Promise<void> {
        KJ_IF_MAYBE(b, body) {
          auto req = session.proppatchRequest();
          req.setPath(path);
          req.setXmlContent(*b);
          auto streamer = initContext(req.initContext(), headers);
          return handleResponse(req.send(), kj::mv(streamer), response);
        } else {
          return kj::READY_NOW;
        }
      });
    }

    case kj::HttpMethod::UNLOCK: {
      auto req = session.unlockRequest();
      req.setPath(path);
      KJ_IF_MAYBE(token, headers.get(tables.hLockToken)) {
        req.setLockToken(*token);
      }
      auto streamer = initContext(req.initContext(), headers);
      return handleResponse(req.send(), kj::mv(streamer), response);
    }

    case kj::HttpMethod::ACL: {
      return davXmlContent(headers, requestBody, response)
          .then([this,path,&headers,&response](kj::Maybe<kj::String> body) -> kj::Promise<void> {
        KJ_IF_MAYBE(b, body) {
          auto req = session.aclRequest();
          req.setPath(path);
          req.setXmlContent(*b);
          auto streamer = initContext(req.initContext(), headers);
          return handleResponse(req.send(), kj::mv(streamer), response);
        } else {
          return kj::READY_NOW;
        }
      });
    }

    case kj::HttpMethod::REPORT: {
      return requestBody.readAllBytes()
          .then([this,path,&headers,&response](kj::Array<byte> data) {
        auto req = session.reportRequest();
        req.setPath(path);
        auto content = req.initContent();
        content.setContent(data);
        initContent(content, headers);
        auto streamer = initContext(req.initContext(), headers);
        return handleResponse(req.send(), kj::mv(streamer), response);
      });
    }

    case kj::HttpMethod::OPTIONS: {
      auto req = session.optionsRequest();
      req.setPath(path);
      auto streamer = initContext(req.initContext(), headers);
      // TODO(cleanup): Refactor initContext() so that we can avoid creating a stream here.
      streamer.streamer->fulfill(newNoStreamingByteStream());
      return req.send()
          .then([this,&response](capnp::Response<WebSession::Options> options) mutable {
        kj::HttpHeaders respHeaders(tables.headerTable);
        kj::Vector<kj::StringPtr> dav;
        if (options.getDavClass1()) dav.add("1");
        if (options.getDavClass2()) dav.add("2");
        if (options.getDavClass3()) dav.add("3");
        for (auto ext: options.getDavExtensions()) {
          // TODO(soon): Validate extension names?
          dav.add(ext);
        }

        if (!dav.empty()) {
          respHeaders.set(tables.hDav, kj::strArray(dav, ", "));
          respHeaders.set(tables.hAccessControlExposeHeaders, "DAV");
        }

        response.send(200, "OK", respHeaders, uint64_t(0));
      }, [this,&response](kj::Exception&& e) {
        if (e.getType() == kj::Exception::Type::UNIMPLEMENTED) {
          // Nothing to say.
          kj::HttpHeaders respHeaders(tables.headerTable);
          response.send(200, "OK", respHeaders, uint64_t(0));
        } else {
          kj::throwRecoverableException(kj::mv(e));
        }
      });
    }

    default:
      return response.sendError(501, "Not Implemented", tables.headerTable);
  }
}

kj::String WebSessionBridge::davDestination(const kj::HttpHeaders& headers) {
  auto dest = KJ_REQUIRE_NONNULL(headers.get(tables.hDestination), "missing destination");

  // We allow host-relative URLs even though the spec doesn't. If an absolute URL is given then we
  // must verify that the host matches.
  if (!dest.startsWith("/")) {
    // Absolute URL.
    auto url = kj::Url::parse(dest);

    auto host = KJ_ASSERT_NONNULL(headers.get(kj::HttpHeaderId::HOST));
    KJ_REQUIRE(url.host == host, "DAV 'Destination' header must point to same host");

    dest = url.toString(kj::Url::HTTP_REQUEST);
  }

  // Remove leading '/'.
  return kj::str(dest.slice(1));
}

bool WebSessionBridge::davNoOverwrite(const kj::HttpHeaders& headers) {
  auto str = headers.get(tables.hOverwrite).orDefault("t");
  return str == "f" || str == "F";
}

bool WebSessionBridge::davShallow(const kj::HttpHeaders& headers) {
  return headers.get(tables.hDepth).orDefault("1") == "0";
}

WebSession::PropfindDepth WebSessionBridge::davPropfindDepth(const kj::HttpHeaders& headers) {
  auto depth = headers.get(tables.hDepth).orDefault("2");
  return depth == "0" ? WebSession::PropfindDepth::ZERO
       : depth == "1" ? WebSession::PropfindDepth::ONE
                      : WebSession::PropfindDepth::INFINITY_;
}

kj::Promise<kj::Maybe<kj::String>> WebSessionBridge::davXmlContent(
    const kj::HttpHeaders& headers, kj::AsyncInputStream& body, Response& response) {
  auto type = headers.get(kj::HttpHeaderId::CONTENT_TYPE)
      .orDefault("application/xml; charset=UTF-8");

  auto pos = type.findFirst('/').orDefault(0);
  if (type.slice(pos) != "/xml" && !type.slice(pos).startsWith("/xml;")) {
    // Wrong type.
    return response.sendError(415, "Unsupported media type.", tables.headerTable)
        .then([]() -> kj::Maybe<kj::String> { return nullptr; });
  }

  KJ_IF_MAYBE(enc, headers.get(tables.hContentEncoding)) {
    KJ_REQUIRE(*enc == "gzip", "unknown Content-Encoding", *enc);

    auto zstream = kj::heap<kj::GzipAsyncInputStream>(body);
    auto promise = zstream->readAllText();
    return promise.attach(kj::mv(zstream))
        .then([](kj::String str) -> kj::Maybe<kj::String> { return kj::mv(str); });
  } else {
    return body.readAllText()
        .then([](kj::String str) -> kj::Maybe<kj::String> { return kj::mv(str); });
  }
}

namespace {

class WebSocketPipe final : public kj::AsyncIoStream, public kj::Refcounted,
                            private kj::TaskSet::ErrorHandler {
  // Class which adapts a pair of WebSession::WebSocketStreams into an AsyncIoStream which in turn
  // can be wrapped by a kj::WebSocket using kj::newWebSocket().
  //
  // TODO(apibump): Currently WebSocketStream (the Cap'n Proto interface) doesn't understand
  //   the WebSocket protocol semantics and instead streams raw bytes, leaving it up to Sandstorm
  //   apps to implement the WebSocket message framing protocol themselves. But KJ *does*
  //   understand WebSocket, so this is a waste: we're losing the parsing that KJ has done by
  //   turning things back into bytes. We should update WebSocketStream to pass messages rather
  //   than bytes, and then get rid of this convoluted class. This will require a change to the
  //   Sandstorm API, though, with a version bump and a compatibility shim.

public:
  WebSocketPipe(WebSession::WebSocketStream::Client outgoing)
      : outgoing(kj::mv(outgoing)),
        writeTasks(*this) {}

  WebSession::WebSocketStream::Client getIncomingStreamCapability() {
    return kj::heap<WebSocketStreamImpl>(kj::addRef(*this));
  }

  // ---------------------------------------------------------------------------
  // outgoing direction

  void shutdownWrite() override {
    outgoing = nullptr;
  }

  kj::Promise<void> write(const void* buffer, size_t size) override {
    auto req = KJ_REQUIRE_NONNULL(outgoing, "already called shutdownWrite()").sendBytesRequest();
    req.setMessage(kj::arrayPtr(reinterpret_cast<const byte*>(buffer), size));
    return writeImpl(size, kj::mv(req));
  }

  kj::Promise<void> write(kj::ArrayPtr<const kj::ArrayPtr<const byte>> pieces) override {
    size_t size = 0;
    for (auto piece: pieces) {
      size += piece.size();
    }

    auto req = KJ_REQUIRE_NONNULL(outgoing, "already called shutdownWrite()").sendBytesRequest();
    auto builder = req.initMessage(size);

    byte* pos = builder.begin();
    for (auto piece: pieces) {
      memcpy(pos, piece.begin(), piece.size());
      pos += piece.size();
    }
    KJ_ASSERT(pos == builder.end());

    return writeImpl(size, kj::mv(req));
  }

private:
  kj::Promise<void> writeImpl(size_t size, capnp::Request<
      WebSession::WebSocketStream::SendBytesParams,
      WebSession::WebSocketStream::SendBytesResults>&& req) {
    KJ_IF_MAYBE(e, writeError) {
      return kj::cp(*e);
    }

    writeTasks.add(req.send().then([this,size](auto&& response) {
      bytesInFlight -= size;
      if (bytesInFlight < MAX_IN_FLIGHT) {
        KJ_IF_MAYBE(f, writeReadyFulfiller) {
          f->get()->fulfill();
        }
      }
    }));
    bytesInFlight += size;

    if (bytesInFlight < MAX_IN_FLIGHT) {
      return kj::READY_NOW;
    } else {
      auto paf = kj::newPromiseAndFulfiller<void>();
      writeReadyFulfiller = kj::mv(paf.fulfiller);
      return kj::mv(paf.promise);
    }
  }

  void taskFailed(kj::Exception&& exception) override {
    KJ_IF_MAYBE(f, writeReadyFulfiller) {
      f->get()->reject(kj::mv(exception));
      writeReadyFulfiller = nullptr;
    }
    writeError = kj::mv(exception);
  }

public:
  // ---------------------------------------------------------------------------
  // incoming direction

  kj::Promise<size_t> tryRead(void* buffer, size_t minBytes, size_t maxBytes) override {
    KJ_SWITCH_ONEOF(current) {
      KJ_CASE_ONEOF(w, CurrentWrite) {
        if (maxBytes < w.buffer.size()) {
          // Entire read satisfied by write, write is still pending.
          memcpy(buffer, w.buffer.begin(), maxBytes);
          w.buffer = w.buffer.slice(maxBytes, w.buffer.size());
          return maxBytes;
        } else if (minBytes <= w.buffer.size()) {
          // Read is satisfied by write and consumes entire write.
          size_t result = w.buffer.size();
          memcpy(buffer, w.buffer.begin(), result);
          w.fulfiller->fulfill();
          current = None();
          return result;
        } else {
          // Read consumes entire write and is not satisfied.
          size_t alreadyRead = w.buffer.size();
          memcpy(buffer, w.buffer.begin(), alreadyRead);
          w.fulfiller->fulfill();
          auto paf = kj::newPromiseAndFulfiller<size_t>();
          current = CurrentRead {
            kj::arrayPtr(reinterpret_cast<byte*>(buffer) + alreadyRead, maxBytes - alreadyRead),
            minBytes - alreadyRead,
            alreadyRead,
            kj::mv(paf.fulfiller)
          };
          return kj::mv(paf.promise);
        }
      }
      KJ_CASE_ONEOF(r, CurrentRead) {
        KJ_FAIL_REQUIRE("can only call read() once at a time");
      }
      KJ_CASE_ONEOF(e, Eof) {
        return size_t(0);
      }
      KJ_CASE_ONEOF(n, None) {
        auto paf = kj::newPromiseAndFulfiller<size_t>();
        current = CurrentRead {
          kj::arrayPtr(reinterpret_cast<byte*>(buffer), maxBytes),
          minBytes,
          0,
          kj::mv(paf.fulfiller)
        };
        return kj::mv(paf.promise);
      }
    }
    KJ_UNREACHABLE;
  }

  kj::Promise<void> fulfillRead(kj::ArrayPtr<const byte> data) {
    KJ_SWITCH_ONEOF(current) {
      KJ_CASE_ONEOF(w, CurrentWrite) {
        KJ_FAIL_REQUIRE("can only call write() once at a time");
      }
      KJ_CASE_ONEOF(r, CurrentRead) {
        if (data.size() < r.minBytes) {
          // Write does not complete the current read.
          memcpy(r.buffer.begin(), data.begin(), data.size());
          r.minBytes -= data.size();
          r.alreadyRead += data.size();
          r.buffer = r.buffer.slice(data.size(), r.buffer.size());
          return kj::READY_NOW;
        } else if (data.size() <= r.buffer.size()) {
          // Write satisfies the current read, and read satisfies the write.
          memcpy(r.buffer.begin(), data.begin(), data.size());
          r.fulfiller->fulfill(r.alreadyRead + data.size());
          current = None();
          return kj::READY_NOW;
        } else {
          // Write satisfies the read and still has more data leftover to write.
          size_t amount = r.buffer.size();
          memcpy(r.buffer.begin(), data.begin(), amount);
          r.fulfiller->fulfill(amount + r.alreadyRead);
          auto paf = kj::newPromiseAndFulfiller<void>();
          current = CurrentWrite { data.slice(amount, data.size()), kj::mv(paf.fulfiller) };
          return kj::mv(paf.promise);
        }
      }
      KJ_CASE_ONEOF(e, Eof) {
        KJ_FAIL_REQUIRE("write after EOF");
      }
      KJ_CASE_ONEOF(n, None) {
        auto paf = kj::newPromiseAndFulfiller<void>();
        current = CurrentWrite { data, kj::mv(paf.fulfiller) };
        return kj::mv(paf.promise);
      }
    }
    KJ_UNREACHABLE;
  }

private:
  // Outgoing direction.
  static constexpr size_t MAX_IN_FLIGHT = 65536;
  size_t bytesInFlight = 0;
  kj::Maybe<kj::Own<kj::PromiseFulfiller<void>>> writeReadyFulfiller;
  kj::Maybe<kj::Exception> writeError;
  kj::Maybe<WebSession::WebSocketStream::Client> outgoing;
  kj::TaskSet writeTasks;

  // Incoming direction.
  struct CurrentWrite {
    kj::ArrayPtr<const byte> buffer;
    kj::Own<kj::PromiseFulfiller<void>> fulfiller;
  };
  struct CurrentRead {
    kj::ArrayPtr<byte> buffer;
    size_t minBytes;
    size_t alreadyRead;
    kj::Own<kj::PromiseFulfiller<size_t>> fulfiller;
  };
  struct Eof {};
  struct None {};

  kj::OneOf<CurrentWrite, CurrentRead, Eof, None> current = None();

  class WebSocketStreamImpl final: public WebSession::WebSocketStream::Server {
  public:
    WebSocketStreamImpl(kj::Own<WebSocketPipe> pipe): pipe(kj::mv(pipe)) {}

  protected:
    kj::Promise<void> sendBytes(SendBytesContext context) override {
      // Some apps will call sendBytes() multiple times concurrently, so we need to queue.
      auto fork = queue.then([this,context]() mutable {
        return pipe->fulfillRead(context.getParams().getMessage());
      }).fork();
      queue = fork.addBranch();
      return fork.addBranch();
    }

  private:
    kj::Own<WebSocketPipe> pipe;
    kj::Promise<void> queue = kj::READY_NOW;
  };
};

class EntropySourceImpl: public kj::EntropySource {
public:
  void generate(kj::ArrayPtr<byte> buffer) {
    randombytes_buf(buffer.begin(), buffer.size());
  }
};

class NoStreamingByteStream: public ByteStream::Server {
public:
  kj::Promise<void> write(WriteContext context) override {
    KJ_FAIL_REQUIRE("streamed response not expected");
  }

  kj::Promise<void> done(DoneContext context) override {
    KJ_FAIL_REQUIRE("streamed response not expected");
  }

  kj::Promise<void> expectSize(ExpectSizeContext context) override {
    KJ_FAIL_REQUIRE("streamed response not expected");
  }
};

}  // namespace

static inline ByteStream::Client newNoStreamingByteStream() {
  return kj::heap<NoStreamingByteStream>();
}

kj::Promise<void> WebSessionBridge::openWebSocket(
    kj::StringPtr path, const kj::HttpHeaders& headers, Response& response) {
  KJ_REQUIRE(path.startsWith("/"));
  path = path.slice(1);

  auto req = session.openWebSocketRequest();
  req.setPath(path);

  auto streamer = initContext(req.initContext(), headers);

  // We never use the response stream for WebSockets, so fulfill it to a stream that throws on all
  // calls.
  // (We don't fulfill the stream itself to an exception because this implies something went
  // wrong, but nothing did.)
  streamer.streamer->fulfill(kj::heap<NoStreamingByteStream>());

  KJ_IF_MAYBE(proto, headers.get(tables.hSecWebSocketProtocol)) {
    auto protos = split(*proto, ',');
    auto listBuilder = req.initProtocol(protos.size());
    for (auto i: kj::indices(protos)) {
      listBuilder.set(i, trim(protos[i]));
    }
  }

  auto clientStreamPaf = kj::newPromiseAndFulfiller<WebSession::WebSocketStream::Client>();
  req.setClientStream(kj::mv(clientStreamPaf.promise));

  auto& clientStreamFulfillerRef = *clientStreamPaf.fulfiller;

  return req.send()
      .then([this, &response, &clientStreamFulfillerRef]
            (capnp::Response<WebSession::OpenWebSocketResults>&& rpcResponse) mutable {
    kj::HttpHeaders headers(tables.headerTable);

    auto protos = rpcResponse.getProtocol();
    if (protos.size() > 0) {
      headers.set(tables.hSecWebSocketProtocol, kj::strArray(protos, ", "));
    }

    auto wsToClient = response.acceptWebSocket(headers);

    // Combine the client stream and server stream into an AsyncIoStream.
    // Wrap that in a WebSocket.
    // pump

    auto wsPipe = kj::refcounted<WebSocketPipe>(rpcResponse.getServerStream());

    static EntropySourceImpl entropySource;

    clientStreamFulfillerRef.fulfill(wsPipe->getIncomingStreamCapability());
    auto wsToServer = kj::newWebSocket(kj::mv(wsPipe), entropySource);

    auto promises = kj::heapArrayBuilder<kj::Promise<void>>(2);
    promises.add(wsToClient->pumpTo(*wsToServer));
    promises.add(wsToServer->pumpTo(*wsToClient));
    return kj::joinPromises(promises.finish()).attach(kj::mv(wsToClient), kj::mv(wsToServer));
  }, [&clientStreamFulfillerRef](kj::Exception&& e) -> kj::Promise<void> {
    clientStreamFulfillerRef.reject(kj::cp(e));
    return kj::mv(e);
  }).attach(kj::mv(clientStreamPaf.fulfiller));
}

class WebSessionBridge::ByteStreamImpl: public ByteStream::Server {
public:
  ByteStreamImpl(uint statusCode, kj::StringPtr statusText,
                 kj::HttpHeaders&& headers,
                 kj::HttpService::Response& response) {
    state.init<NotStarted>(NotStarted { statusCode, statusText, kj::mv(headers), response });
  }

  ~ByteStreamImpl() noexcept(false) {
    KJ_IF_MAYBE(a, aborter) {
      a->obj = nullptr;
    }

    KJ_IF_MAYBE(df, doneFulfiller) {
      if (df->get()->isWaiting()) {
        df->get()->reject(KJ_EXCEPTION(FAILED,
            "app did not finish writing HTTP response stream"));
      }
    }
  }

  kj::Own<void> makeAborter() {
    return kj::heap<Aborter>(*this);
  }

  kj::Promise<void> whenDone() {
    auto paf = kj::newPromiseAndFulfiller<void>();
    doneFulfiller = kj::mv(paf.fulfiller);
    return kj::mv(paf.promise);
  }

  kj::Promise<void> write(WriteContext context) override {
    auto fork = queue.then([this,context]() mutable {
      auto& stream = ensureStarted(nullptr);
      auto data = context.getParams().getData();
      return stream.write(data.begin(), data.size());
    }).fork();
    queue = fork.addBranch();
    return fork.addBranch();
  }

  kj::Promise<void> done(DoneContext context) override {
    auto fork = queue.then([this]() {
      ensureStarted(uint64_t(0));
      state.init<Done>();
      KJ_IF_MAYBE(df, doneFulfiller) {
        df->get()->fulfill();
      };
    }).fork();
    queue = fork.addBranch();
    return fork.addBranch();
  }

  kj::Promise<void> expectSize(ExpectSizeContext context) override {
    ensureStarted(context.getParams().getSize());
    return kj::READY_NOW;
  }

private:
  struct NotStarted {
    uint statusCode;
    kj::StringPtr statusText;
    kj::HttpHeaders headers;
    kj::HttpService::Response& response;
  };

  struct Started {
    kj::Own<kj::AsyncOutputStream> output;
  };

  struct Done {};

  class Aborter: public kj::Refcounted {
  public:
    Aborter(ByteStreamImpl& obj): obj(obj) {
      KJ_REQUIRE(obj.aborter == nullptr);
      obj.aborter = *this;
    }
    ~Aborter() noexcept(false) {
      KJ_IF_MAYBE(o, obj) {
        o->aborter = nullptr;
        o->abort();
      }
    }

    kj::Maybe<ByteStreamImpl&> obj;
  };

  kj::OneOf<NotStarted, Started, Done> state;
  kj::Maybe<kj::Own<kj::PromiseFulfiller<void>>> doneFulfiller;
  kj::Promise<void> queue = kj::READY_NOW;
  kj::Maybe<Aborter&> aborter;

  kj::AsyncOutputStream& ensureStarted(kj::Maybe<uint64_t> size) {
    if (state.is<NotStarted>()) {
      auto& ns = state.get<NotStarted>();
      auto stream = ns.response.send(ns.statusCode, ns.statusText, ns.headers, size);
      kj::AsyncOutputStream& ref = *stream;
      state.init<Started>(Started { kj::mv(stream) });
      return ref;
    } else {
      KJ_REQUIRE(!state.is<Done>(), "already called done()");
      return *state.get<Started>().output;
    }
  }

  void abort() {
    if (!state.is<Done>()) {
      queue = KJ_EXCEPTION(DISCONNECTED, "HTTP response aborted");
      state.init<Done>();
      KJ_IF_MAYBE(df, doneFulfiller) {
        df->get()->reject(KJ_EXCEPTION(FAILED, "ByteStreamImpl aborted"));
      }
    }
  }
};

WebSessionBridge::StreamAborterPair WebSessionBridge::makeHttpResponseStream(
    uint statusCode, kj::StringPtr statusText,
    kj::HttpHeaders&& headers,
    kj::HttpService::Response& response) {
  auto result = kj::heap<ByteStreamImpl>(statusCode, statusText, kj::mv(headers), response);
  auto aborter = result->makeAborter();
  return { kj::mv(result), kj::mv(aborter) };
}

template <typename T>
inline HttpStatusDescriptor::Reader WebSessionBridge::lookupStatus(
    kj::ArrayPtr<const HttpStatusDescriptor::Reader> table,
    T codeEnum) {
  if (static_cast<uint>(codeEnum) < table.size()) {
    return table[static_cast<uint>(codeEnum)];
  } else {
    // The first item in each table happens to be a reasonable generic code for that table.
    return table.front();
  }
}

WebSessionBridge::ContextInitInfo WebSessionBridge::initContext(
    WebSession::Context::Builder context, const kj::HttpHeaders& headers) {
  bool hadIfNoneMatch = false;

  auto paf = kj::newPromiseAndFulfiller<ByteStream::Client>();
  context.setResponseStream(kj::mv(paf.promise));

  if (options.allowCookies) {
    KJ_IF_MAYBE(cookiesText, headers.get(tables.hCookie)) {
      auto cookies = split(*cookiesText, ';');
      auto listBuilder = context.initCookies(cookies.size());
      for (auto i: kj::indices(cookies)) {
        kj::ArrayPtr<const char> cookie = cookies[i];
        auto cookieBuilder = listBuilder[i];
        KJ_IF_MAYBE(name, splitFirst(cookie, '=')) {
          cookieBuilder.setKey(trim(*name));
          cookieBuilder.setValue(trim(cookie));
        } else {
          cookieBuilder.setKey(trim(cookie));
        }
      }
    }
  }

  KJ_IF_MAYBE(accept, headers.get(tables.hAccept)) {
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

  KJ_IF_MAYBE(accept, headers.get(tables.hAcceptEncoding)) {
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

  KJ_IF_MAYBE(match, headers.get(tables.hIfMatch)) {
    if (*match == "*") {
      context.getETagPrecondition().setExists();
    } else {
      context.getETagPrecondition().adoptMatchesOneOf(
          parseETagList(capnp::Orphanage::getForMessageContaining(context), *match));
    }
  } else KJ_IF_MAYBE(match, headers.get(tables.hIfNoneMatch)) {
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
    if (tables.requestHeaderWhitelist.matches(name)) {
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
void WebSessionBridge::initContent(Builder&& builder, const kj::HttpHeaders& headers) {
  KJ_IF_MAYBE(value, headers.get(tables.hContentEncoding)) {
    builder.setEncoding(*value);
  }
  KJ_IF_MAYBE(value, headers.get(kj::HttpHeaderId::CONTENT_TYPE)) {
    builder.setMimeType(*value);
  }
}

capnp::Orphan<capnp::List<WebSession::ETag>> WebSessionBridge::parseETagList(
    capnp::Orphanage orphanage, kj::StringPtr text,
    kj::Vector<kj::Tuple<kj::String, bool>> parsed) {
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

kj::Tuple<kj::String, bool> WebSessionBridge::parseETagInternal(kj::StringPtr& text) {
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

kj::Promise<void> WebSessionBridge::handleStreamingRequestResponse(
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

kj::Promise<void> WebSessionBridge::handleResponse(
    kj::Promise<capnp::Response<WebSession::Response>>&& promise,
    ContextInitInfo&& contextInitInfo,
    kj::HttpService::Response& out) {
  return promise.then([this,KJ_MVCAP(contextInitInfo),&out](
      capnp::Response<WebSession::Response>&& in) mutable -> kj::Promise<void> {
    // TODO(someday): cachePolicy (not supported in Sandstorm proper as of this writing)

    loadingIndicator = nullptr;

    kj::HttpHeaders headers(tables.headerTable);

    if (options.allowCookies && in.hasSetCookies()) {
      for (auto cookie: in.getSetCookies()) {
        kj::Vector<kj::StringPtr> parts;
        char date[40];
        kj::Vector<kj::String> ownParts;

        auto name = cookie.getName();
        auto value = cookie.getValue();
        auto path = cookie.getPath();

        if (name.findFirst(';') != nullptr ||
            name.findFirst(',') != nullptr ||
            name.findFirst('=') != nullptr ||
            value.findFirst(';') != nullptr ||
            value.findFirst(',') != nullptr ||
            path.findFirst(';') != nullptr ||
            path.findFirst(',') != nullptr) {
          // Ignore invalid cookie.
          continue;
        }

        if (parts.size() > 0) {
          parts.add(", ");
        }

        parts.add(name);
        parts.add("=");
        parts.add(value);

        auto expires = cookie.getExpires();
        switch (expires.which()) {
          case WebSession::Cookie::Expires::NONE:
            // nothing
            break;
          case WebSession::Cookie::Expires::ABSOLUTE: {
            parts.add("; Expires=");

            time_t seconds = expires.getAbsolute();
            struct tm tm;
            KJ_ASSERT(gmtime_r(&seconds, &tm) == &tm);
            KJ_ASSERT(strftime(date, sizeof(date), "%a, %d %b %Y %H:%M:%S %z", &tm) > 0);

            auto dateStr = kj::str(date);
            parts.add(dateStr);
            ownParts.add(kj::mv(dateStr));
            break;
          }
          case WebSession::Cookie::Expires::RELATIVE: {
            parts.add("; Max-Age=");
            auto maxAge = kj::str(expires.getRelative());
            parts.add(maxAge);
            ownParts.add(kj::mv(maxAge));
            break;
          }
        }

        if (path.size() > 0) {
          parts.add("; Path=");
          parts.add(path);
        }

        if (cookie.getHttpOnly()) {
          parts.add("; HttpOnly");
        }

        if (options.isHttps) {
          parts.add("; Secure");
        }

        // HACK: Multiple Set-Cookie headers cannot be folded like other headers, as the Set-Cookie
        //   header spec screwed up and used commas for a different purpose. But if we don't index
        //   the Set-Cookie header in the HttpTable, and instead add it using a string name, then
        //   the KJ HTTP library won't automatically fold values.
        // TODO(cleanup): Handle this in KJ HTTP somehow.
        headers.add("Set-Cookie", kj::strArray(parts, ""));
      }
    }

    KJ_IF_MAYBE(v, options.vary) {
      headers.set(tables.hVary, *v);
    }
    KJ_IF_MAYBE(acao, options.accessControlAllowOrigin) {
      headers.set(tables.hAccessControlAllowOrigin, *acao);
    }
    KJ_IF_MAYBE(csp, options.contentSecurityPolicy) {
      headers.set(tables.hContentSecurityPolicy, *csp);
    }

    for (auto addlHeader: in.getAdditionalHeaders()) {
      auto name = addlHeader.getName();
      if (tables.responseHeaderWhitelist.matches(name)) {
        headers.add(name, addlHeader.getValue());
      }
    }

    // If we complete this function without calling fulfill() to connect the stream, then this is
    // not a streaming response. Fulfill the stream to something whose methods throw exceptions.
    // (We don't fulfill the stream itself to an exception because this implies something went
    // wrong, but nothing did.)
    KJ_DEFER(contextInitInfo.streamer->fulfill(kj::heap<NoStreamingByteStream>()));

    switch (in.which()) {
      case WebSession::Response::CONTENT: {
        auto content = in.getContent();

        auto status = lookupStatus(tables.successCodeTable, content.getStatusCode());

        if (content.hasEncoding()) {
          headers.set(tables.hContentEncoding, content.getEncoding());
        }
        if (content.hasLanguage()) {
          headers.set(tables.hContentLanguage, content.getLanguage());
        }
        if (content.hasMimeType()) {
          headers.set(kj::HttpHeaderId::CONTENT_TYPE, content.getMimeType());
        }

        if (content.hasETag()) {
          setETag(headers, content.getETag());
        }

        auto disposition = content.getDisposition();
        switch (disposition.which()) {
          case WebSession::Response::Content::Disposition::NORMAL:
            break;
          case WebSession::Response::Content::Disposition::DOWNLOAD: {
            headers.set(tables.hContentDisposition,
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
                status.getId(), status.getTitle(), headers.clone(), out);
            auto aborter = outStream->makeAborter();
            auto promise = outStream->whenDone();
            contextInitInfo.streamer->fulfill(kj::mv(outStream));
            return promise.attach(kj::mv(handle), kj::mv(aborter));
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
          out.send(412, "Precondition Failed", headers, uint64_t(0));
          return kj::READY_NOW;
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

        auto status = lookupStatus(tables.errorCodeTable, error.getStatusCode());

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
kj::Promise<void> WebSessionBridge::handleErrorBody(
    T error, uint statusCode, kj::StringPtr statusText,
    kj::HttpHeaders& headers,
    capnp::Response<WebSession::Response>&& in,
    kj::HttpService::Response& out) {
  kj::ArrayPtr<const byte> data;
  if (error.hasNonHtmlBody()) {
    auto body = error.getNonHtmlBody();
    headers.set(kj::HttpHeaderId::CONTENT_TYPE, body.getMimeType());

    if (body.hasEncoding()) {
      headers.set(tables.hContentEncoding, body.getEncoding());
    }
    if (body.hasLanguage()) {
      headers.set(tables.hContentLanguage, body.getLanguage());
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

void WebSessionBridge::setETag(kj::HttpHeaders& headers, WebSession::ETag::Reader etag) {
  if (etag.getWeak()) {
    headers.set(tables.hETag, kj::str("W/\"", etag.getValue(), "\""));
  } else {
    headers.set(tables.hETag, kj::str("\"", etag.getValue(), "\""));
  }
}

kj::String WebSessionBridge::escape(kj::StringPtr value) {
  kj::Vector<char> chars(value.size() + 1);

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

  chars.add('\0');

  return kj::String(chars.releaseAsArray());
}

}  // namespace sandstorm
