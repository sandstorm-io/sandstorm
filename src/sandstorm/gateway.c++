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
#include "util.h"

namespace sandstorm {

GatewayService::Tables::Tables(kj::HttpHeaderTable::Builder& headerTableBuilder)
    : headerTable(headerTableBuilder.getFutureTable()),
      hAccessControlAllowOrigin(headerTableBuilder.add("Access-Control-Allow-Origin")),
      hAcceptLanguage(headerTableBuilder.add("Accept-Language")),
      hCookie(headerTableBuilder.add("Cookie")),
      hLocation(headerTableBuilder.add("Location")),
      hUserAgent(headerTableBuilder.add("User-Agent")),
      bridgeTables(headerTableBuilder) {}

GatewayService::GatewayService(
    kj::Timer& timer, kj::HttpClient& shellHttp, GatewayRouter::Client router,
    Tables& tables, kj::StringPtr baseUrl, kj::StringPtr wildcardHost)
    : timer(timer), shellHttp(kj::newHttpService(shellHttp)), router(kj::mv(router)),
      tables(tables), baseUrl(kj::Url::parse(baseUrl, kj::Url::HTTP_PROXY_REQUEST)),
      wildcardHost(wildcardHost) {}

kj::Promise<void> GatewayService::cleanupLoop() {
  static constexpr auto PURGE_PERIOD = 2 * kj::MINUTES;

  isPurging = true;
  return timer.afterDelay(PURGE_PERIOD).then([this]() {
    auto now = timer.now();
    auto iter = uiHosts.begin();
    while (iter != uiHosts.end()) {
      auto next = iter;
      ++next;

      if (now - iter->second.lastUsed >= PURGE_PERIOD) {
        uiHosts.erase(iter);
      }
      iter = next;
    }
    return cleanupLoop();
  });
}

kj::Promise<void> GatewayService::request(
    kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
    kj::AsyncInputStream& requestBody, Response& response) {
  KJ_ASSERT(isPurging, "forgot to call cleanupLoop()");

  KJ_IF_MAYBE(hostId, wildcardHost.match(headers)) {
    // TODO(now): Redirect HTTP -> HTTPS when needed. Requires X-Forwarded-Proto?

    if (*hostId == "static") {
      // TODO(soon): Static asset hosting.
    } else if (hostId->startsWith("api-")) {
      // TODO(soon): API hosts.
    } else if (hostId->startsWith("selftest-")) {
      if (method == kj::HttpMethod::GET && url == "/") {
        kj::HttpHeaders responseHeaders(tables.headerTable);
        responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "text/plain");
        responseHeaders.set(tables.hAccessControlAllowOrigin, "*");
        kj::StringPtr content = "Self-test OK.";
        auto stream = response.send(200, "OK", responseHeaders, content.size());
        auto promise = stream->write(content.begin(), content.size());
        return promise.attach(kj::mv(stream));
      } else {
        return response.sendError(400, "Bad Request", tables.headerTable);
      }
    } else if (hostId->startsWith("ui-")) {
      if (url.startsWith("/_sandstorm-init?")) {
        auto parsed = kj::Url::parse(url, kj::Url::HTTP_REQUEST);
        KJ_REQUIRE(parsed.query.size() == 2);
        KJ_REQUIRE(parsed.query[0].name == "sessionid");
        KJ_REQUIRE(parsed.query[1].name == "path");
        KJ_REQUIRE(parsed.query[1].value.startsWith("/"));

        kj::HttpHeaders responseHeaders(tables.headerTable);
        // We avoid registering a header ID for Set-Cookie. See comments in web-session-bridge.c++.
        responseHeaders.add("Set-Cookie", kj::str("sandstorm-sid=", parsed.query[0].value));
        responseHeaders.set(tables.hLocation, parsed.query[1].value);

        response.send(303, "See Other", responseHeaders, uint64_t(0));
        return kj::READY_NOW;
      }

      auto headersCopy = kj::heap(headers.cloneShallow());
      KJ_IF_MAYBE(bridge, getUiBridge(*headersCopy)) {
        auto promise = bridge->get()->request(method, url, *headersCopy, requestBody, response);
        return promise.attach(kj::mv(bridge), kj::mv(headersCopy));
      } else {
        // TODO(now): Write an error message mentioning lack of cookies.
        return response.sendError(403, "Unauthorized", tables.headerTable);
      }
    } else {
      // TODO(soon): Handle "public ID" hosts. Before we can start handling these, we must
      //   transition to UI hosts being prefixed with "ui-".
    }
  }

  // TODO(perf): Serve Meteor static assets directly, *unless* the server is in dev mode.

  // Fall back to shell.
  return shellHttp->request(method, url, headers, requestBody, response);
}

kj::Promise<void> GatewayService::openWebSocket(
    kj::StringPtr url, const kj::HttpHeaders& headers, WebSocketResponse& response) {
  KJ_IF_MAYBE(hostId, wildcardHost.match(headers)) {
    // TODO(now): Redirect HTTP -> HTTPS when needed. Requires X-Forwarded-Proto?

    if (hostId->startsWith("api-")) {
      // TODO(soon): API hosts.
    } else if (hostId->startsWith("ui-")) {
      auto headersCopy = kj::heap(headers.cloneShallow());
      KJ_IF_MAYBE(bridge, getUiBridge(*headersCopy)) {
        auto promise = bridge->get()->openWebSocket(url, *headersCopy, response);
        return promise.attach(kj::mv(bridge), kj::mv(headersCopy));
      } else {
        // TODO(now): Write an error message mentioning lack of cookies.
        return response.sendError(403, "Unauthorized", tables.headerTable);
      }
    }
  }

  // Fall back to shell.
  return shellHttp->openWebSocket(url, headers, response);
}

WildcardMatcher::WildcardMatcher(kj::StringPtr wildcardHost) {
  size_t starPos = KJ_REQUIRE_NONNULL(
      wildcardHost.findFirst('*'), "WILDCARD_HOST must contain an astrisk");

  prefix = kj::str(wildcardHost.slice(0, starPos));
  suffix = kj::str(wildcardHost.slice(starPos + 1));
}

kj::Maybe<kj::String> WildcardMatcher::match(const kj::HttpHeaders& headers) {
  KJ_IF_MAYBE(host, headers.get(kj::HttpHeaderId::HOST)) {
    return match(*host);
  } else {
    return nullptr;
  }
}

kj::Maybe<kj::String> WildcardMatcher::match(kj::StringPtr host) {
  if (host.size() > prefix.size() + suffix.size() &&
      host.startsWith(prefix) && host.endsWith(suffix)) {
    return kj::str(host.slice(prefix.size(), host.size() - suffix.size()));
  } else {
    return nullptr;
  }
}

kj::Maybe<kj::Own<kj::HttpService>> GatewayService::getUiBridge(kj::HttpHeaders& headers) {
  kj::Vector<kj::String> forwardedCookies;
  kj::String sessionId;

  KJ_IF_MAYBE(cookiesText, headers.get(tables.hCookie)) {
    auto cookies = split(*cookiesText, ';');
    for (auto& cookie: cookies) {
      auto trimmed = trim(cookie);
      if (trimmed.startsWith("sandstorm-sid=")) {
        sessionId = kj::str(trimmed.slice(strlen("sandstorm-sid=")));
      } else {
        forwardedCookies.add(kj::mv(trimmed));
      }
    }
  }

  if (sessionId == nullptr) {
    return nullptr;
  }

  if (forwardedCookies.empty()) {
    headers.unset(tables.hCookie);
  } else {
    headers.set(tables.hCookie, kj::strArray(forwardedCookies, "; "));
  }

  auto iter = uiHosts.find(sessionId);
  if (iter == uiHosts.end()) {
    capnp::MallocMessageBuilder requestMessage(128);
    auto params = requestMessage.getRoot<WebSession::Params>();

    params.setBasePath(kj::str(baseUrl.scheme, "://",
        KJ_ASSERT_NONNULL(headers.get(kj::HttpHeaderId::HOST))));
    params.setUserAgent(headers.get(tables.hUserAgent).orDefault("UnknownAgent/0.0"));

    KJ_IF_MAYBE(languages, headers.get(tables.hAcceptLanguage)) {
      auto langs = KJ_MAP(lang, split(*languages, ',')) { return trim(lang); };
      params.setAcceptableLanguages(KJ_MAP(l, langs) -> capnp::Text::Reader { return l; });
    } else {
      params.setAcceptableLanguages({"en-US", "en"});
    }

    auto ownParams = newOwnCapnp(params.asReader());

    WebSessionBridge::Options options;
    options.allowCookies = true;
    options.isHttps = baseUrl.scheme == "https";

    kj::StringPtr key = sessionId;

    // Use a CapRedirector to re-establish the session on disconenct.
    //
    // TODO(perf): This forces excessive copying of RPC requests and responses. We should add a
    //   ClientHook-based library to Cap'n Proto implementing the CapRedirector pattern more
    //   efficiently.
    capnp::Capability::Client sessionRedirector = kj::heap<CapRedirector>(
        [router = this->router,KJ_MVCAP(ownParams),KJ_MVCAP(sessionId)]() mutable
        -> capnp::Capability::Client {
      auto req = router.openUiSessionRequest();
      req.setSessionCookie(sessionId);
      req.setParams(ownParams);
      return req.send().getSession();
    });

    UiHostEntry entry {
      timer.now(),
      kj::refcounted<WebSessionBridge>(sessionRedirector.castAs<WebSession>(),
                                       tables.bridgeTables, options)
    };
    auto insertResult = uiHosts.insert(std::make_pair(key, kj::mv(entry)));
    KJ_ASSERT(insertResult.second);
    iter = insertResult.first;

    // TODO(now): expire entries
  } else {
    iter->second.lastUsed = timer.now();
  }

  return kj::addRef(*iter->second.bridge);
}

}  // namespace sandstorm
