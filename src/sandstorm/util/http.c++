#include "http.h"

namespace sandstorm::util::http {

ExtraHeadersResponse::ExtraHeadersResponse(kj::HttpService::Response& orig, kj::HttpHeaders&& extraHeaders)
  : origResponse(orig),
  extraHeaders(kj::mv(extraHeaders)) {}

kj::HttpHeaders ExtraHeadersResponse::addExtraHeaders(const kj::HttpHeaders& headers) {
  // Return a shallow copy of `headers` with `extraHeaders` added to it.
  kj::HttpHeaders newHeaders = headers.cloneShallow();
  extraHeaders.forEach(
    [&](kj::HttpHeaderId id, kj::StringPtr value) {
      newHeaders.set(id, value);
    },
    [&](kj::StringPtr name, kj::StringPtr value) {
      newHeaders.add(name, value);
    }
  );
  return kj::mv(newHeaders);
}

kj::Own<kj::AsyncOutputStream> ExtraHeadersResponse::send(
    kj::uint statusCode, kj::StringPtr statusText, const kj::HttpHeaders& headers,
    kj::Maybe<uint64_t> expectedBodySize) {
  return origResponse.send(statusCode, statusText, addExtraHeaders(headers), expectedBodySize);
}

kj::Own<kj::WebSocket> ExtraHeadersResponse::acceptWebSocket(const kj::HttpHeaders& headers) {
  return origResponse.acceptWebSocket(addExtraHeaders(headers));
}

};
