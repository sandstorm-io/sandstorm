// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// This file is part of the Sandstorm API, which is licensed as follows.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this
//    list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
// ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

// This program is useful for including in Sandstorm application packages where
// the application itself is a legacy HTTP web server that does not understand
// how to speak the Cap'n Proto interface directly.  This program will start up
// that server and then redirect incoming requests to it over standard HTTP on
// the loopback network interface.

// Hack around stdlib bug with C++14.
#include <initializer_list>  // force libstdc++ to include its config
#undef _GLIBCXX_HAVE_GETS    // correct broken config
// End hack.

#include <kj/main.h>
#include <kj/debug.h>
#include <kj/async-io.h>
#include <capnp/rpc-twoparty.h>
#include <capnp/rpc.capnp.h>
#include <capnp/schema.h>
#include <unistd.h>
#include <map>
#include <unordered_map>
#include <time.h>
#include <stdlib.h>

#include <sys/socket.h>
#include <sys/un.h>
#include <fcntl.h>
#include <sandstorm/grain.capnp.h>
#include <sandstorm/web-session.capnp.h>
#include <sandstorm/email.capnp.h>
#include <sandstorm/hack-session.capnp.h>
#include <joyent-http/http_parser.h>

#include "version.h"

namespace sandstorm {

#if __QTCREATOR
#define KJ_MVCAP(var) var
// QtCreator dosen't understand C++14 syntax yet.
#else
#define KJ_MVCAP(var) var = ::kj::mv(var)
// Capture the given variable by move.  Place this in a lambda capture list.  Requires C++14.
//
// TODO(cleanup):  Move to libkj.
#endif

typedef unsigned int uint;
typedef unsigned char byte;

kj::Vector<kj::ArrayPtr<const char>> split(kj::ArrayPtr<const char> input, char delim) {
  kj::Vector<kj::ArrayPtr<const char>> result;

  size_t start = 0;
  for (size_t i: kj::indices(input)) {
    if (input[i] == delim) {
      result.add(input.slice(start, i));
      start = i + 1;
    }
  }
  result.add(input.slice(start, input.size()));
  return result;
}

kj::Maybe<kj::ArrayPtr<const char>> splitFirst(kj::ArrayPtr<const char>& input, char delim) {
  for (size_t i: kj::indices(input)) {
    if (input[i] == delim) {
      auto result = input.slice(0, i);
      input = input.slice(i + 1, input.size());
      return result;
    }
  }
  return nullptr;
}

kj::ArrayPtr<const char> trim(kj::ArrayPtr<const char> input) {
  while (input.size() > 0 && input[0] == ' ') {
    input = input.slice(1, input.size());
  }
  while (input.size() > 0 && input[input.size() - 1] == ' ') {
    input = input.slice(0, input.size() - 1);
  }
  return input;
}

void toLower(kj::ArrayPtr<char> text) {
  for (char& c: text) {
    if ('A' <= c && c <= 'Z') {
      c = c - 'A' + 'a';
    }
  }
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

  result[301] = redirectInfo(true, true);
  result[302] = redirectInfo(false, true);
  result[303] = redirectInfo(false, true);
  result[307] = redirectInfo(false, false);
  result[308] = redirectInfo(true, false);

  return result;
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wglobal-constructors"
const std::unordered_map<uint, HttpStatusInfo> HTTP_STATUS_CODES = makeStatusCodes();
#pragma clang diagnostic pop

class HttpParser: private http_parser {
public:
  HttpParser() {
    memset(&settings, 0, sizeof(settings));
    settings.on_status = &on_status;
    settings.on_header_field = &on_header_field;
    settings.on_header_value = &on_header_value;
    settings.on_body = &on_body;
    http_parser_init(this, HTTP_RESPONSE);
  }

  void parse(kj::ArrayPtr<const char> data) {
    size_t n = http_parser_execute(this, &settings, data.begin(), data.size());
    if (n != data.size() || HTTP_PARSER_ERRNO(this) != HPE_OK) {
      const char* error = http_errno_description(HTTP_PARSER_ERRNO(this));
      KJ_FAIL_ASSERT("Failed to parse HTTP response from sandboxed app.", error);
    }

    KJ_ASSERT(status_code >= 100, (int)status_code);
  }

  void build(WebSession::Response::Builder builder) {
    // Let the parser know about EOF.
    if (http_parser_execute(this, &settings, nullptr, 0) != 0 ||
        HTTP_PARSER_ERRNO(this) != HPE_OK) {
      const char* error = http_errno_description(HTTP_PARSER_ERRNO(this));
      KJ_FAIL_ASSERT("Failed to parse HTTP response from sandboxed app.", error);
    }

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
        KJ_IF_MAYBE(disposition, findHeader("content-disposition")) {
          // Parse `attachment; filename="foo"`
          // TODO(cleanup):  This is awful.  Use KJ parser library?
          auto parts = split(*disposition, ';');
          if (parts.size() > 1 && kj::str(trim(parts[0])) == "attachment") {
            // Starst with "attachment;".  Parse params.
            for (auto& part: parts.asPtr().slice(1, parts.size())) {
              // Parse a "name=value" parameter.
              for (size_t i: kj::indices(part)) {
                if (part[i] == '=') {
                  // Found '='.  Split and interpret.
                  if (kj::heapString(trim(part.slice(0, i))) == "filename") {
                    // It's "filename=", the one we're looking for!
                    // We need to unquote/unescape the file name.
                    auto filename = trim(part.slice(i + 1, part.size()));

                    if (filename.size() >= 2 && filename[0] != '\"' &&
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
                    }
                  }
                  break;  // Only split at first '='.
                }
              }
            }
          }
        }

        auto data = content.initBody().initBytes(body.size());
        memcpy(data.begin(), body.begin(), body.size());
        break;
      }
      case WebSession::Response::NO_CONTENT: {
        auto noContent = builder.initNoContent();
        noContent.setShouldResetForm(statusInfo.noContent.shouldResetForm);
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
    KJ_ASSERT(status_code == 101, "Sandboxed app does not support WebSocket.",
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

private:
  struct Header {
    kj::String name;
    kj::String value;
  };

  struct Cookie {
    kj::String name;
    kj::String value;
    int64_t expires;

    enum ExpirationType {
      NONE, RELATIVE, ABSOLUTE
    };
    ExpirationType expirationType = NONE;

    bool httpOnly = false;
  };

  http_parser_settings settings;
  kj::String statusString;
  kj::String lastHeaderName;
  std::map<kj::StringPtr, Header> headers;
  kj::Vector<char> body;
  kj::Vector<Cookie> cookies;

  kj::Maybe<kj::StringPtr> findHeader(kj::StringPtr name) {
    auto iter = headers.find(name);
    if (iter == headers.end()) {
      return nullptr;
    } else {
      return kj::StringPtr(iter->second.value);
    }
  }

  void onStatus(kj::ArrayPtr<const char> status) {
    statusString = kj::heapString(status);
  }

  void onHeaderField(kj::ArrayPtr<const char> name) {
    lastHeaderName = kj::heapString(name);
    toLower(lastHeaderName);
  }

  void onHeaderValue(kj::ArrayPtr<const char> value) {
    if (lastHeaderName == "set-cookie") {
      // Really ugly cookie-parsing code.
      // TODO(cleanup):  Clean up.
      bool isFirst = true;
      Cookie cookie;
      for (auto part: split(value, ';')) {
        if (isFirst) {
          isFirst = false;
          cookie.name = kj::heapString(trim(KJ_ASSERT_NONNULL(splitFirst(part, '='),
              "Invalid cookie header from app.", value)));
          cookie.value = kj::heapString(trim(part));
        } else KJ_IF_MAYBE(name, splitFirst(part, '=')) {
          auto prop = kj::heapString(trim(*name));
          toLower(prop);
          if (prop == "expires") {
            auto value = kj::heapString(trim(part));
            // Wed, 15 Nov 1995 06:25:24 GMT
            struct tm t;
            memset(&t, 0, sizeof(t));

            // There are three allowed formats for HTTP dates.  Ugh.
            char* end = strptime(value.cStr(), "%a, %d %b %Y %T GMT", &t);
            if (end == nullptr) {
              end = strptime(value.cStr(), "%a, %d-%b-%y %T GMT", &t);
              if (end == nullptr) {
                end = strptime(value.cStr(), "%a %b %d %T %Y", &t);
              }
            }
            KJ_ASSERT(end != nullptr && *end == '\0', "Invalid HTTP date from app.", value);
            cookie.expires = timegm(&t);
            cookie.expirationType = Cookie::ExpirationType::ABSOLUTE;
          } else if (prop == "max-age") {
            auto value = kj::heapString(trim(part));
            char* end;
            cookie.expires = strtoull(value.cStr(), &end, 10);
            KJ_ASSERT(end > value.begin() && *end == '\0', "Invalid cookie max-age app.", value);
            cookie.expirationType = Cookie::ExpirationType::RELATIVE;
          } else {
            // Ignore other properties:
            //   Path:  Not useful on the modern same-origin-policy web.
            //   Domain:  We do not allow the app to publish cookies visible to other hosts in the
            //     domain.
          }
        } else {
          auto prop = kj::heapString(trim(part));
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
      kj::StringPtr name = lastHeaderName;
      auto& slot = headers[name];
      if (slot.name != nullptr) {
        // Multiple instances of the same header are equivalent to comma-delimited.
        slot.value = kj::str(kj::mv(slot.value), ", ", value);
      } else {
        slot = Header { kj::mv(lastHeaderName), kj::heapString(value) };
      }
    }
  }

  void onBody(kj::ArrayPtr<const char> data) {
    body.addAll(data);
  }

#define ON_C(lower, title) \
  static int on_##lower(http_parser* p, const char* d, size_t s) { \
    static_cast<HttpParser*>(p)->on##title(kj::arrayPtr(d, s)); \
    return 0; \
  }

  ON_C(status, Status)
  ON_C(header_field, HeaderField)
  ON_C(header_value, HeaderValue)
  ON_C(body, Body)
#undef ON_C
};

kj::Promise<kj::Vector<char>> readAll(kj::AsyncIoStream& stream, kj::Vector<char>&& buffer) {
  // TODO(perf):  Optimize Vector<char> to avoid per-element destructor calls.

  size_t offset = buffer.size();
  buffer.resize(kj::max(offset * 2, 4096));
  size_t expected = buffer.size() - offset;
  auto promise = stream.tryRead(buffer.begin() + offset, expected, expected);
  return promise.then(
      [&stream, offset, expected, KJ_MVCAP(buffer)](size_t actual) mutable
      -> kj::Promise<kj::Vector<char>> {
    if (actual < expected) {
      // Got less than expected; must be EOF.
      buffer.resize(offset + actual);
      return kj::mv(buffer);
    } else {
      // Sill going; read more.
      return readAll(stream, kj::mv(buffer));
    }
  });
}

kj::Promise<kj::Vector<char>> readAll(kj::Own<kj::AsyncIoStream>&& stream) {
  auto& streamRef = *stream;
  return readAll(streamRef, kj::Vector<char>()).attach(kj::mv(stream));
}

struct ResponseHeaders {
  kj::Vector<char> headers;
  kj::Array<byte> firstData;
};

kj::Maybe<ResponseHeaders> trySeparateHeaders(kj::Vector<char>& data) {
  // Look for the end of the headers.  If found, consume `data` and return ResponseHeaders,
  // otherwise leave `data` as-is and return nullptr.

  char prev1 = '\0';
  char prev2 = '\0';

  for (size_t i: kj::indices(data)) {
    char c = data[i];
    if (c == '\n') {
      if (prev1 == '\n' || (prev1 == '\r' && prev2 == '\n')) {
        auto postHeaders = data.asPtr().slice(i + 1, data.size());
        ResponseHeaders result;
        result.firstData = kj::heapArray<byte>(reinterpret_cast<byte*>(postHeaders.begin()),
                                               postHeaders.size());
        data.resize(i);
        result.headers = kj::mv(data);
        return kj::mv(result);
      }
    }

    prev2 = prev1;
    prev1 = c;
  }

  return nullptr;
}

kj::Promise<ResponseHeaders> readResponseHeaders(
    kj::AsyncIoStream& stream, kj::Vector<char>&& buffer) {
  size_t offset = buffer.size();
  buffer.resize(kj::max(offset * 2, 4096));
  size_t expected = buffer.size() - offset;
  auto promise = stream.tryRead(buffer.begin() + offset, 1, expected);
  return promise.then(
      [&stream, offset, expected, KJ_MVCAP(buffer)](size_t actual) mutable
      -> kj::Promise<ResponseHeaders> {
    if (actual < expected) {
      buffer.resize(offset + actual);
    }

    KJ_IF_MAYBE(result, trySeparateHeaders(buffer)) {
      // Done with headers.
      return kj::mv(*result);
    }

    if (actual < expected) {
      // Got less than expected; must be EOF.
      return ResponseHeaders { kj::mv(buffer), nullptr };
    } else {
      // Sill going; read more.
      return readResponseHeaders(stream, kj::mv(buffer));
    }
  });
}

kj::Promise<ResponseHeaders> readResponseHeaders(kj::AsyncIoStream& stream) {
  return readResponseHeaders(stream, kj::Vector<char>());
}

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
    tasks.add(request.send().then([](auto response) {}));
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

class WebSessionImpl final: public HackSession::Server {
public:
  WebSessionImpl(kj::NetworkAddress& serverAddr,
                 UserInfo::Reader userInfo, SessionContext::Client context,
                 WebSession::Params::Reader params)
      : serverAddr(serverAddr),
        context(kj::mv(context)),
        userDisplayName(kj::heapString(userInfo.getDisplayName().getDefaultText())),
        basePath(kj::heapString(params.getBasePath())),
        userAgent(kj::heapString(params.getUserAgent())),
        acceptLanguages(kj::strArray(params.getAcceptableLanguages(), ",")) {}

  kj::Promise<void> get(GetContext context) override {
    GetParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders("GET", params.getPath(), params.getContext());
    return sendRequest(toBytes(httpRequest), context);
  }

  kj::Promise<void> post(PostContext context) override {
    PostParams::Reader params = context.getParams();
    auto content = params.getContent();
    kj::String httpRequest = makeHeaders("POST", params.getPath(), params.getContext(),
      kj::str("Content-Type: ", content.getMimeType()),
      kj::str("Content-Length: ", content.getContent().size()));
    return sendRequest(toBytes(httpRequest, content.getContent()), context);
  }

  kj::Promise<void> put(PutContext context) override {
    PutParams::Reader params = context.getParams();
    auto content = params.getContent();
    kj::String httpRequest = makeHeaders("PUT", params.getPath(), params.getContext(),
      kj::str("Content-Type: ", content.getMimeType()),
      kj::str("Content-Length: ", content.getContent().size()));
    return sendRequest(toBytes(httpRequest, content.getContent()), context);
  }

  kj::Promise<void> delete_(DeleteContext context) override {
    DeleteParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders("DELETE", params.getPath(), params.getContext());
    return sendRequest(toBytes(httpRequest), context);
  }

  kj::Promise<void> openWebSocket(OpenWebSocketContext context) override {
    // TODO(soon):  Use actual random Sec-WebSocket-Key?  Unclear if this has any importance when
    //   not trying to work around broken proxies.

    auto params = context.getParams();

    kj::Vector<kj::String> lines(16);

    lines.add(kj::str("GET /", params.getPath(), " HTTP/1.1"));
    lines.add(kj::str("Upgrade: websocket"));
    lines.add(kj::str("Connection: Upgrade"));
    lines.add(kj::str("Sec-WebSocket-Key: mj9i153gxeYNlGDoKdoXOQ=="));
    auto protocols = params.getProtocol();
    if (protocols.size() > 0) {
      lines.add(kj::str("Sec-WebSocket-Protocol: ", kj::strArray(params.getProtocol(), ", ")));
    }
    lines.add(kj::str("Sec-WebSocket-Version: 13"));

    addCommonHeaders(lines, params.getContext());

    auto httpRequest = toBytes(kj::strArray(lines, "\r\n"));
    WebSession::WebSocketStream::Client clientStream = params.getClientStream();

    context.releaseParams();
    return serverAddr.connect().then(
        [KJ_MVCAP(httpRequest), KJ_MVCAP(clientStream), context]
        (kj::Own<kj::AsyncIoStream>&& stream) mutable {
      kj::ArrayPtr<const byte> httpRequestRef = httpRequest;
      auto& streamRef = *stream;
      return streamRef.write(httpRequestRef.begin(), httpRequestRef.size())
          .attach(kj::mv(httpRequest))
          .then([&streamRef]() { return readResponseHeaders(streamRef); })
          .then([KJ_MVCAP(stream), KJ_MVCAP(clientStream), context]
                (ResponseHeaders&& headers) mutable {
            KJ_ASSERT(headers.headers.size() > 0, "Sandboxed server returned no data.");
            HttpParser parser;
            parser.parse(headers.headers);
            auto results = context.getResults();
            parser.buildForWebSocket(results);

            auto pump = kj::heap<WebSocketPump>(kj::mv(stream), kj::mv(clientStream));

            if (headers.firstData.size() > 0) {
              pump->sendData(headers.firstData);
            }

            pump->pump();
            results.setServerStream(kj::mv(pump));
          });
    });
  }

  kj::String genRandomString(const int len) {
    auto s = kj::heapString(len);
    static const char alphanum[] =
        "0123456789"
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "abcdefghijklmnopqrstuvwxyz";

    for (int i = 0; i < len; ++i) {
        s[i] = alphanum[rand() % (sizeof(alphanum) - 1)];
    }

    return s;
  }

  kj::Promise<void> send(SendContext context) override {
    char fileTemplate[255] = "/var/mail/tmp/";
    strcat(fileTemplate, std::to_string(time(NULL)).c_str());
    strcat(fileTemplate, ".XXXXXX");

    int mailFd;
    KJ_SYSCALL(mailFd = mkstemp(fileTemplate));

    auto email = context.getParams().getEmail();

    #define WRITE_HEADER(key, value, len) \
      if(len != 0) { \
        KJ_SYSCALL(write(mailFd, #key ": ", strlen(#key ": "))); \
        KJ_SYSCALL(write(mailFd, value, len)); \
        KJ_SYSCALL(write(mailFd, "\n", 1)); \
      }

    #define WRITE_FIELD(fieldName, headerName) \
      WRITE_HEADER(headerName, email.get##fieldName().cStr(), email.get##fieldName().size())

    #define WRITE_EMAIL(headerName, field) \
      WRITE_HEADER(headerName, field.getAddress().cStr(), field.getAddress().size())

    #define WRITE_EMAIL_FIELD(fieldName, headerName) \
      WRITE_EMAIL(headerName, email.get##fieldName())

    #define WRITE_EMAIL_LIST(fieldName, headerName) \
      for(auto one : email.get##fieldName()) { \
        WRITE_EMAIL(headerName, one) \
      }

    #define WRITE_FIELD_LIST(fieldName, headerName) \
      for(auto one : email.get##fieldName()) { \
        WRITE_HEADER(headerName, one.cStr(), one.size()) \
      }

    // TODO: parse and write Date
    WRITE_FIELD(Subject, Subject)
    WRITE_FIELD(MessageId, Message-Id)

    WRITE_EMAIL_FIELD(From, From)
    WRITE_EMAIL_FIELD(ReplyTo, Reply-To)
    
    WRITE_EMAIL_LIST(To, To)
    WRITE_EMAIL_LIST(Cc, CC)
    WRITE_EMAIL_LIST(Bcc, BCC)

    WRITE_FIELD_LIST(InReplyTo, In-Reply-To)
    WRITE_FIELD_LIST(References, References)

    auto boundary = genRandomString(28);
    // TODO: check if leading \n is neccessary
    auto boundaryLine = kj::str("\n--", boundary, "\n");
    auto contentType = kj::str("multipart/alternative; boundary=", boundary);
    WRITE_HEADER(Content-Type, contentType.cStr(), contentType.size())

    KJ_SYSCALL(write(mailFd, "\n", 1)); // Start body
    if(email.getText().size() > 0) {
      auto contentTypeText = kj::str("text/plain; charset=UTF-8");
      KJ_SYSCALL(write(mailFd, boundaryLine.cStr(), boundaryLine.size()));
      WRITE_HEADER(Content-Type, contentTypeText.cStr(), contentTypeText.size())
      KJ_SYSCALL(write(mailFd, email.getText().cStr(), email.getText().size()));
    }
    if(email.getHtml().size() > 0) {
      auto contentTypeHtml = kj::str("text/html; charset=UTF-8");
      KJ_SYSCALL(write(mailFd, boundaryLine.cStr(), boundaryLine.size()));
      WRITE_HEADER(Content-Type, contentTypeHtml.cStr(), contentTypeHtml.size())
      KJ_SYSCALL(write(mailFd, email.getHtml().cStr(), email.getHtml().size()));
    }
    KJ_SYSCALL(write(mailFd, boundaryLine.cStr(), boundaryLine.size()));

    close(mailFd);

    // TODO: handle html

    std::string newPath(fileTemplate);
    newPath.replace(10, 3, "new"); // replace "tmp" with "new"
    KJ_SYSCALL(rename(fileTemplate, newPath.c_str()));

    return kj::READY_NOW;

    #undef WRITE_FIELD
    #undef WRITE_HEADER
    #undef WRITE_EMAIL
    #undef WRITE_EMAIL_FIELD
    #undef WRITE_EMAIL_LIST
  }

private:
  kj::NetworkAddress& serverAddr;
  SessionContext::Client context;
  kj::String userDisplayName;
  kj::String basePath;
  kj::String userAgent;
  kj::String acceptLanguages;

  kj::String makeHeaders(kj::StringPtr method, kj::StringPtr path,
                         WebSession::Context::Reader context,
                         kj::String extraHeader1 = nullptr,
                         kj::String extraHeader2 = nullptr) {
    kj::Vector<kj::String> lines(16);

    lines.add(kj::str(method, " /", path, " HTTP/1.1"));
    lines.add(kj::str("Connection: close"));
    if (extraHeader1 != nullptr) {
      lines.add(kj::mv(extraHeader1));
    }
    if (extraHeader2 != nullptr) {
      lines.add(kj::mv(extraHeader2));
    }
    lines.add(kj::str("Accept: */*"));
    lines.add(kj::str("Accept-Encoding: gzip"));
    lines.add(kj::str("Accept-Language: ", acceptLanguages));

    addCommonHeaders(lines, context);

    return kj::strArray(lines, "\r\n");
  }

  void addCommonHeaders(kj::Vector<kj::String>& lines, WebSession::Context::Reader context) {
    lines.add(kj::str("Host: sandbox"));
    lines.add(kj::str("User-Agent: ", userAgent));
    lines.add(kj::str("X-Sandstorm-Username: ", userDisplayName));
    lines.add(kj::str("X-Sandstorm-Base-Path: ", basePath));

    auto cookies = context.getCookies();
    if (cookies.size() > 0) {
      lines.add(kj::str("Cookie: ", kj::strArray(
            KJ_MAP(c, cookies) {
              return kj::str(c.getKey(), "=", c.getValue());
            }, "; ")));
    }

    lines.add(kj::str(""));
    lines.add(kj::str(""));
  }

  kj::Array<byte> toBytes(kj::StringPtr text, kj::ArrayPtr<const byte> data = nullptr) {
    auto result = kj::heapArray<byte>(text.size() + data.size());
    memcpy(result.begin(), text.begin(), text.size());
    memcpy(result.begin() + text.size(), data.begin(), data.size());
    return result;
  }

  template <typename Context>
  kj::Promise<void> sendRequest(kj::Array<byte> httpRequest, Context& context) {
    context.releaseParams();
    return serverAddr.connect().then(
        [KJ_MVCAP(httpRequest)](kj::Own<kj::AsyncIoStream>&& stream) mutable {
      kj::ArrayPtr<const byte> httpRequestRef = httpRequest;
      auto& streamRef = *stream;
      return streamRef.write(httpRequestRef.begin(), httpRequestRef.size())
          .attach(kj::mv(httpRequest))
          .then([KJ_MVCAP(stream)]() mutable {
        // Note:  Do not do stream->shutdownWrite() as some HTTP servers will decide to close the
        // socket immediately on EOF, even if they have not actually responded to previous requests
        // yet.
        return readAll(kj::mv(stream));
      });
    }).then([context](kj::Vector<char>&& buffer) mutable {
      KJ_ASSERT(buffer.size() > 0, "Sandboxed server returned no data.");
      HttpParser parser;
      parser.parse(buffer);
      parser.build(context.getResults());
    });
  }
};


class UiViewImpl final: public UiView::Server {
public:
  explicit UiViewImpl(kj::NetworkAddress& serverAddress, kj::PromiseFulfillerPair<capnp::Capability::Client>& fulfillerPair): fulfillerPair(fulfillerPair), serverAddress(serverAddress) {}

//  kj::Promise<void> getViewInfo(GetViewInfoContext context) override;

  kj::Promise<void> newSession(NewSessionContext context) override {
    auto params = context.getParams();

    KJ_REQUIRE(params.getSessionType() == capnp::typeId<WebSession>(),
               "Unsupported session type.");

    context.getResults(capnp::MessageSize {2, 1}).setSession(
        kj::heap<WebSessionImpl>(serverAddress, params.getUserInfo(), params.getContext(),
                                 params.getSessionParams().getAs<WebSession::Params>()));
    fulfillerPair.fulfiller->fulfill(params.getContext());

    return kj::READY_NOW;
  }

  kj::PromiseFulfillerPair<capnp::Capability::Client>& fulfillerPair;

private:
  kj::NetworkAddress& serverAddress;
};

class LegacyBridgeMain {
  // Main class for the Sandstorm legacy bridge.  This program is meant to run inside an
  // application sandbox where it translates incoming requests back from HTTP-over-RPC to regular
  // HTTP.  This is a shim meant to make it easy to port existing web frameworks into Sandstorm,
  // but long-term apps should seek to drop this binary and instead speak Cap'n Proto directly.
  // It is up to the app to include this binary in their package if they want it.

public:
  LegacyBridgeMain(kj::ProcessContext& context): context(context), ioContext(kj::setupAsyncIo()) {}

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

  class Restorer: public capnp::SturdyRefRestorer<capnp::AnyPointer> {
  public:
    explicit Restorer(capnp::Capability::Client&& defaultCap)
        : defaultCap(kj::mv(defaultCap)) {}

    capnp::Capability::Client restore(capnp::AnyPointer::Reader ref) override {
      // TODO(soon):  Make it possible to export a default capability on two-party connections.
      //   For now we use a null ref as a hack, but this is questionable because if guessable
      //   SturdyRefs exist then you can't let just any component of your system request arbitrary
      //   SturdyRefs.
      if (ref.isNull() || ref.getAs< ::capnp::Text>() == "SessionContext") {
        return defaultCap;
      }

      // TODO(someday):  Implement level 2 RPC?
      KJ_FAIL_ASSERT("SturdyRefs not implemented.");
    }

  private:
    capnp::Capability::Client defaultCap;
  };

  class ApiRestorer: public capnp::SturdyRefRestorer<capnp::AnyPointer> {
  public:
    explicit ApiRestorer(SandstormApi::Client&& apiCap, capnp::Capability::Client&& sessionContext)
        : apiCap(kj::mv(apiCap)), sessionContext(sessionContext) {}

    capnp::Capability::Client restore(capnp::AnyPointer::Reader ref) override {
      auto text = ref.getAs< ::capnp::Text>();

      if(text == "SandstormApi")
        return apiCap;
      else if(text == "SessionContext")
        return sessionContext;

      KJ_FAIL_ASSERT("Ref wasn't equal to either 'SandstormApi' or 'SessionContext'");
    }

  private:
    SandstormApi::Client apiCap;
    capnp::Capability::Client sessionContext;
  };

  struct AcceptedConnection {
    kj::Own<kj::AsyncIoStream> connection;
    capnp::TwoPartyVatNetwork network;
    capnp::RpcSystem<capnp::rpc::twoparty::SturdyRefHostId> rpcSystem;

    explicit AcceptedConnection(ApiRestorer& restorer, kj::Own<kj::AsyncIoStream>&& connectionParam)
        : connection(kj::mv(connectionParam)),
          network(*connection, capnp::rpc::twoparty::Side::SERVER),
          rpcSystem(capnp::makeRpcServer(network, restorer)) {}
  };

  kj::Promise<void> acceptLoop(kj::ConnectionReceiver& serverPort, ApiRestorer& restorer,
                               kj::TaskSet& taskSet) {
    return serverPort.accept().then([&](kj::Own<kj::AsyncIoStream>&& connection) {
      auto connectionState = kj::heap<AcceptedConnection>(restorer, kj::mv(connection));
      auto promise = connectionState->network.onDisconnect();
      taskSet.add(promise.attach(kj::mv(connectionState)));
      return acceptLoop(serverPort, restorer, taskSet);
    });
  }

  class ErrorHandlerImpl: public kj::TaskSet::ErrorHandler {
  public:
    void taskFailed(kj::Exception&& exception) override {
      KJ_LOG(ERROR, "connection failed", exception);
    }
  };

  kj::MainBuilder::Validity run() {
    pid_t child;
    KJ_SYSCALL(child = fork());
    if (child == 0) {
      // We're in the child.
      close(3);  // Close Supervisor's Cap'n Proto socket to avoid confusion.

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

      // Wait until connections are accepted.
      bool success = false;
      for (;;) {
        kj::runCatchingExceptions([&]() {
          address->connect().wait(ioContext.waitScope);
          success = true;
        });
        if (success) break;

        // Wait 10ms and try again.
        usleep(10000);
      }
      auto fulfillerPair = kj::newPromiseAndFulfiller<capnp::Capability::Client>();

      auto stream = ioContext.lowLevelProvider->wrapSocketFd(3);
      capnp::TwoPartyVatNetwork network(*stream, capnp::rpc::twoparty::Side::CLIENT);
      Restorer restorer(kj::heap<UiViewImpl>(*address, fulfillerPair));
      auto rpcSystem = capnp::makeRpcServer(network, restorer);

      // Get the SandstormApi by restoring a null SturdyRef.
      capnp::MallocMessageBuilder message;
      capnp::rpc::SturdyRef::Builder ref = message.getRoot<capnp::rpc::SturdyRef>();
      auto hostId = ref.getHostId().initAs<capnp::rpc::twoparty::SturdyRefHostId>();
      hostId.setSide(capnp::rpc::twoparty::Side::SERVER);
      SandstormApi::Client api = rpcSystem.restore(
          hostId, ref.getObjectId()).castAs<SandstormApi>();

      ApiRestorer appRestorer(kj::mv(api), kj::mv(fulfillerPair.promise));
      ErrorHandlerImpl errorHandler;
      kj::TaskSet tasks(errorHandler);
      unlink("/var/socket-api");  // Clear stale socket, if any.
      auto acceptTask = ioContext.provider->getNetwork().parseAddress("unix:/var/socket-api", 0).then(
          [&](kj::Own<kj::NetworkAddress>&& addr) {
        auto serverPort = addr->listen();
        auto promise = acceptLoop(*serverPort, appRestorer, tasks);
        return promise.attach(kj::mv(serverPort));
      });

      // TODO(soon):  Exit when child exits.  (Signal handler?)
      kj::NEVER_DONE.wait(ioContext.waitScope);
    }
  }

private:
  kj::ProcessContext& context;
  kj::AsyncIoContext ioContext;
  kj::Own<kj::NetworkAddress> address;
  kj::Vector<kj::String> command;
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::LegacyBridgeMain)
