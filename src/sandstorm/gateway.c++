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

#include "gateway.h"
#include <kj/compat/url.h>
#include <kj/debug.h>

namespace sandstorm {

GatewayService::GatewayService(
    kj::Timer& timer, kj::HttpClient& shellHttp, GatewayRouter::Client router,
    kj::HttpHeaderTable::Builder& headerTableBuilder,
    kj::StringPtr baseUrl, kj::StringPtr wildcardHost)
    : timer(timer), shellHttp(kj::newHttpService(shellHttp)), router(kj::mv(router)),
      headerTable(headerTableBuilder.getFutureTable()),
      baseUrl(kj::Url::parse(baseUrl, kj::Url::HTTP_PROXY_REQUEST)),
      hAccessControlAllowOrigin(headerTableBuilder.add("Access-Control-Allow-Origin")) {
  size_t starPos = KJ_REQUIRE_NONNULL(
      wildcardHost.findFirst('*'), "WILDCARD_HOST must contain an astrisk");

  wildcardHostPrefix = kj::str(wildcardHost.slice(0, starPos));
  wildcardHostSuffix = kj::str(wildcardHost.slice(starPos + 1));
}

kj::Promise<void> GatewayService::request(
    kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
    kj::AsyncInputStream& requestBody, Response& response) {
  KJ_IF_MAYBE(hostId, matchWildcardHost(headers)) {
    // TODO(now): Redirect HTTP -> HTTPS when needed. Requires X-Forwarded-Proto?

    if (*hostId == "static") {
      // TODO(soon): Static asset hosting.
    } else if (hostId->startsWith("api-")) {
      // TODO(soon): API hosts.
    } else if (hostId->startsWith("selftest-")) {
      if (method == kj::HttpMethod::GET && url == "/") {
        kj::HttpHeaders responseHeaders(headerTable);
        responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "text/plain");
        responseHeaders.set(hAccessControlAllowOrigin, "*");
        kj::StringPtr content = "Self-test OK.";
        auto stream = response.send(200, "OK", responseHeaders, content.size());
        auto promise = stream->write(content.begin(), content.size());
        return promise.attach(kj::mv(stream));
      } else {
        return response.sendError(400, "Bad Request", headerTable);
      }
    } else if (hostId->startsWith("ui-")) {
      // TODO(now): Handle UI hosts.
    } else {
      // TODO(soon): Handle "public ID" hosts. Before we can start handling these, we must
      //   transition to UI hosts being prefixed with "ui-".
    }
  }

  // Fall back to shell.
  return shellHttp->request(method, url, headers, requestBody, response);
}

kj::Promise<void> GatewayService::openWebSocket(
    kj::StringPtr url, const kj::HttpHeaders& headers, WebSocketResponse& response) {
  KJ_IF_MAYBE(hostId, matchWildcardHost(headers)) {
    // TODO(now): Redirect HTTP -> HTTPS when needed. Requires X-Forwarded-Proto?

    if (hostId->startsWith("api-")) {
      // TODO(soon): API hosts.
    } else if (hostId->startsWith("ui-")) {
      // TODO(now): Handle UI hosts.
    }
  }

  // Fall back to shell.
  return shellHttp->openWebSocket(url, headers, response);
}

kj::Maybe<kj::String> GatewayService::matchWildcardHost(const kj::HttpHeaders& headers) {
  KJ_IF_MAYBE(host, headers.get(kj::HttpHeaderId::HOST)) {
    if (host->size() > wildcardHostPrefix.size() + wildcardHostSuffix.size() &&
        host->startsWith(wildcardHostPrefix) && host->endsWith(wildcardHostSuffix)) {
      return kj::str(host->slice(
          wildcardHostPrefix.size(), host->size() - wildcardHostSuffix.size()));
    } else {
      return nullptr;
    }
  } else {
    return nullptr;
  }
}

}  // namespace sandstorm
