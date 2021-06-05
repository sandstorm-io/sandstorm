#include "http.h"

namespace sandstorm::util::http {

ExtraHeadersResponse::ExtraHeadersResponse(kj::HttpService::Response& orig, kj::HttpHeaders&& extraHeaders)
  : origResponse(orig),
  extraHeaders(kj::mv(extraHeaders)) {}

void ExtraHeadersResponse::updateHeaders(const kj::HttpHeaders& headers) {
  // Update `extraHeaders` by copying the contents of `headers` into it.
  kj::HttpHeaders newHeaders = headers.cloneShallow();
  extraHeaders.forEach(
    [&](kj::HttpHeaderId id, kj::StringPtr value) {
      newHeaders.set(id, value);
    },
    [&](kj::StringPtr name, kj::StringPtr value) {
      newHeaders.add(name, value);
    }
  );
  extraHeaders = kj::mv(newHeaders);
}

kj::Own<kj::AsyncOutputStream> ExtraHeadersResponse::send(
    kj::uint statusCode, kj::StringPtr statusText, const kj::HttpHeaders& headers,
    kj::Maybe<uint64_t> expectedBodySize) {
  updateHeaders(headers);
  return origResponse.send(statusCode, statusText, extraHeaders, expectedBodySize);
}

kj::Own<kj::WebSocket> ExtraHeadersResponse::acceptWebSocket(const kj::HttpHeaders& headers) {
  updateHeaders(headers);
  return origResponse.acceptWebSocket(extraHeaders);
}

};
