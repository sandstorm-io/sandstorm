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
#include <map>
#include "web-session-bridge.h"

namespace sandstorm {

class WildcardMatcher {
public:
  WildcardMatcher() = default;
  WildcardMatcher(kj::StringPtr wildcardHost);

  kj::Maybe<kj::String> match(const kj::HttpHeaders& headers);
  kj::Maybe<kj::String> match(kj::StringPtr host);

private:
  kj::String prefix;
  kj::String suffix;
};

class GatewayService: public kj::HttpService {
public:
  class Tables {
    // Tables that many instances of GatewayService might share. Create this object at startup
    // time and pass it to the constructor of each GatewayService.

  public:
    Tables(kj::HttpHeaderTable::Builder& headerTableBuilder);

  private:
    friend class GatewayService;

    const kj::HttpHeaderTable& headerTable;

    kj::HttpHeaderId hAccessControlAllowOrigin;
    kj::HttpHeaderId hAcceptLanguage;
    kj::HttpHeaderId hCookie;
    kj::HttpHeaderId hLocation;
    kj::HttpHeaderId hUserAgent;

    WebSessionBridge::Tables bridgeTables;
  };

  GatewayService(kj::Timer& timer, kj::HttpClient& shellHttp, GatewayRouter::Client router,
                 Tables& tables, kj::StringPtr baseUrl, kj::StringPtr wildcardHost);

  kj::Promise<void> cleanupLoop();
  // Must run this to purge expired capabilities.

  kj::Promise<void> request(
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, Response& response) override;

  kj::Promise<void> openWebSocket(
      kj::StringPtr url, const kj::HttpHeaders& headers, WebSocketResponse& response) override;

private:
  kj::Timer& timer;
  kj::Own<kj::HttpService> shellHttp;
  GatewayRouter::Client router;
  Tables& tables;

  kj::Url baseUrl;
  WildcardMatcher wildcardHost;

  struct UiHostEntry {
    kj::TimePoint lastUsed;
    kj::Own<WebSessionBridge> bridge;
  };

  std::map<kj::StringPtr, UiHostEntry> uiHosts;

  bool isPurging = false;

  kj::Maybe<kj::Own<kj::HttpService>> getUiBridge(kj::HttpHeaders& headers);
};

}  // namespace sandstorm

#endif // SANDSTORM_GATEWAY_H_
