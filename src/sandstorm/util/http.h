#pragma once
#include <kj/compat/http.h>

namespace sandstorm::util::http {

class ExtraHeadersResponse final : public kj::HttpService::Response {
public:
  ExtraHeadersResponse(kj::HttpService::Response& orig, kj::HttpHeaders&& extraHeaders);

  kj::HttpHeaders& headers();

  // Implements Response
  kj::Own<kj::AsyncOutputStream> send(
      kj::uint statusCode, kj::StringPtr statusText, const kj::HttpHeaders& headers,
      kj::Maybe<uint64_t> expectedBodySize = nullptr);
  kj::Own<kj::WebSocket> acceptWebSocket(const kj::HttpHeaders& headers);

private:
  void updateHeaders(const kj::HttpHeaders& headers);

  kj::HttpService::Response& origResponse;
  kj::HttpHeaders extraHeaders;
};
};
