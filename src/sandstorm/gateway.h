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

#ifndef SANDSTORM_GATEWAY_H_
#define SANDSTORM_GATEWAY_H_

#include <kj/compat/http.h>
#include <sandstorm/backend.capnp.h>
#include <kj/compat/url.h>

namespace sandstorm {

class GatewayService: public kj::HttpService {
public:
  GatewayService(kj::Timer& timer, kj::HttpClient& shellHttp, GatewayRouter::Client router,
                 kj::HttpHeaderTable::Builder& headerTableBuilder,
                 kj::StringPtr baseUrl, kj::StringPtr wildcardHost);

  kj::Promise<void> request(
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, Response& response) override;

  kj::Promise<void> openWebSocket(
      kj::StringPtr url, const kj::HttpHeaders& headers, WebSocketResponse& response) override;

private:
  kj::Timer& timer;
  kj::Own<kj::HttpService> shellHttp;
  GatewayRouter::Client router;
  kj::HttpHeaderTable& headerTable;

  kj::Url baseUrl;
  kj::String wildcardHostPrefix;
  kj::String wildcardHostSuffix;
  kj::HttpHeaderId hAccessControlAllowOrigin;

  kj::Maybe<kj::String> matchWildcardHost(const kj::HttpHeaders& headers);
};

}  // namespace sandstorm

#endif // SANDSTORM_GATEWAY_H_
