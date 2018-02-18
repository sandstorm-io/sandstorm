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
#include <kj/compat/tls.h>
#include "web-session-bridge.h"

namespace sandstorm {

class WildcardMatcher {
public:
  WildcardMatcher() = default;
  WildcardMatcher(kj::StringPtr wildcardHost);

  kj::Maybe<kj::String> match(const kj::HttpHeaders& headers);
  kj::Maybe<kj::String> match(kj::StringPtr host);

  kj::String makeHost(kj::StringPtr hostId);

private:
  kj::String prefix;
  kj::String suffix;
};

class GatewayService: public kj::HttpService, private kj::TaskSet::ErrorHandler {
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
    kj::HttpHeaderId hAuthorization;
    kj::HttpHeaderId hCacheControl;
    kj::HttpHeaderId hContentType;
    kj::HttpHeaderId hContentLanguage;
    kj::HttpHeaderId hContentEncoding;
    kj::HttpHeaderId hCookie;
    kj::HttpHeaderId hDav;
    kj::HttpHeaderId hLocation;
    kj::HttpHeaderId hOrigin;
    kj::HttpHeaderId hUserAgent;
    kj::HttpHeaderId hWwwAuthenticate;
    kj::HttpHeaderId hXRealIp;
    kj::HttpHeaderId hXSandstormPassthrough;

    WebSessionBridge::Tables bridgeTables;
  };

  GatewayService(kj::Timer& timer, kj::HttpClient& shellHttp, GatewayRouter::Client router,
                 Tables& tables, kj::StringPtr baseUrl, kj::StringPtr wildcardHost,
                 kj::Maybe<kj::StringPtr> termsPublicId);

  kj::Promise<void> cleanupLoop();
  // Must run this to purge expired capabilities.

  kj::Promise<void> request(
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, Response& response) override;

private:
  kj::Timer& timer;
  kj::Own<kj::HttpService> shellHttp;
  GatewayRouter::Client router;
  Tables& tables;

  kj::Url baseUrl;
  WildcardMatcher wildcardHost;
  kj::Maybe<kj::StringPtr> termsPublicId;

  struct UiHostEntry {
    kj::TimePoint lastUsed;
    kj::Own<WebSessionBridge> bridge;
  };

  std::map<kj::StringPtr, UiHostEntry> uiHosts;

  struct ApiHostEntry {
    kj::TimePoint lastUsed;
    kj::Own<WebSessionBridge> bridge;
  };

  std::map<kj::StringPtr, ApiHostEntry> apiHosts;

  struct StaticPublisherEntry {
    kj::String id;
    uint generation;
    kj::TimePoint lastUsed;
    Supervisor::Client supervisor;

    StaticPublisherEntry(const StaticPublisherEntry&) = delete;
    StaticPublisherEntry(StaticPublisherEntry&&) = default;
  };

  std::map<kj::StringPtr, StaticPublisherEntry> staticPublishers;

  struct ForeignHostnameEntry: public kj::Refcounted {
    kj::String id;
    OwnCapnp<GatewayRouter::ForeignHostnameInfo> info;
    kj::TimePoint refreshAfter;
    kj::TimePoint expires;
    bool currentlyRefreshing;

    ForeignHostnameEntry(kj::String id, GatewayRouter::ForeignHostnameInfo::Reader info,
                         kj::TimePoint now, kj::Duration ttl)
        : id(kj::mv(id)), info(newOwnCapnp(info)),
          refreshAfter(now + ttl / 2), expires(now + ttl),
          currentlyRefreshing(false) {}

    ForeignHostnameEntry(const ForeignHostnameEntry&) = delete;
    ForeignHostnameEntry(ForeignHostnameEntry&&) = default;
    ForeignHostnameEntry& operator=(const ForeignHostnameEntry&) = delete;
    ForeignHostnameEntry& operator=(ForeignHostnameEntry&&) = default;
  };

  std::map<kj::StringPtr, ForeignHostnameEntry> foreignHostnames;

  bool isPurging = false;

  kj::TaskSet tasks;

  kj::Promise<void> sendError(
      uint statusCode, kj::StringPtr statusText, Response& response, kj::StringPtr message);

  kj::Maybe<kj::Own<kj::HttpService>> getUiBridge(kj::HttpHeaders& headers);
  kj::Maybe<kj::String> getAuthToken(const kj::HttpHeaders& headers, bool allowBasicAuth);
  kj::Own<kj::HttpService> getApiBridge(kj::StringPtr token, const kj::HttpHeaders& headers);

  kj::Promise<void> getStaticPublished(
      kj::StringPtr publicId, kj::StringPtr path, const kj::HttpHeaders& headers,
      kj::HttpService::Response& response, uint retryCount = 0);

  kj::Promise<void> handleForeignHostname(kj::StringPtr host,
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, Response& response);

  kj::String unknownForeignHostnameError(kj::StringPtr host);

  void taskFailed(kj::Exception&& exception) override;
};

class GatewayTlsManager: private kj::TaskSet::ErrorHandler {
  // Manages TLS keys and connections.

public:
  GatewayTlsManager(kj::HttpServer& server, kj::NetworkAddress& smtpServer,
                    kj::Maybe<kj::StringPtr> privateKeyPassword)
      : GatewayTlsManager(server, smtpServer, privateKeyPassword,
                          kj::newPromiseAndFulfiller<void>()) {}
  // Password, if provided, must remain valid while GatewayTlsManager exists.

  kj::Promise<void> listenHttps(kj::ConnectionReceiver& port);
  // Given a raw network port, listen for connections, perform TLS handshakes, and serve HTTP over
  // the TLS conenction.
  //
  // No connections will be accepted until setKeys() has been called at least once.

  kj::Promise<void> listenSmtp(kj::ConnectionReceiver& port);
  kj::Promise<void> listenSmtps(kj::ConnectionReceiver& port);

  void setKeys(kj::StringPtr key, kj::StringPtr certChain);
  void unsetKeys();

  kj::Promise<void> subscribeKeys(GatewayRouter::Client gatewayRouter);

private:
  struct RefcountedTlsContext: public kj::Refcounted {
    kj::TlsContext tls;

    template <typename... Params>
    RefcountedTlsContext(Params&&... params)
        : tls(kj::fwd<Params>(params)...) {}
  };

  kj::HttpServer& server;
  kj::NetworkAddress& smtpServer;
  kj::Maybe<kj::StringPtr> privateKeyPassword;

  kj::Maybe<kj::Own<RefcountedTlsContext>> currentTls;
  // Not valid until setKeys() has been called.

  kj::ForkedPromise<void> ready;
  kj::Own<kj::PromiseFulfiller<void>> readyFulfiller;
  // Fulfilled first time setKeys() is called.

  kj::TaskSet tasks;

  GatewayTlsManager(kj::HttpServer& server, kj::NetworkAddress& smtpServer,
                    kj::Maybe<kj::StringPtr> privateKeyPassword,
                    kj::PromiseFulfillerPair<void> readyPaf);

  kj::Promise<void> listenLoop(kj::ConnectionReceiver& port);
  kj::Promise<void> listenSmtpLoop(kj::ConnectionReceiver& port);
  kj::Promise<void> listenSmtpsLoop(kj::ConnectionReceiver& port);

  void taskFailed(kj::Exception&& exception) override;

  class TlsKeyCallbackImpl;
};

class RealIpService: public kj::HttpService {
  // Wrapper that should be instantiated for each connection to capture IP address in X-Real-IP.

public:
  RealIpService(kj::HttpService& inner, kj::HttpHeaderId hXRealIp, kj::AsyncIoStream& connection);

  kj::Promise<void> request(
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, Response& response) override;

private:
  kj::HttpService& inner;
  kj::HttpHeaderId hXRealIp;
  kj::Maybe<kj::String> address;
  bool trustClient = false;
};

class AltPortService: public kj::HttpService {
  // Wrapper that should be exported on ports other than the main port. This will redirect
  // clients to the main port where appropriate.

public:
  AltPortService(kj::HttpService& inner, kj::HttpHeaderTable& headerTable,
                 kj::StringPtr baseUrl, kj::StringPtr wildcardHost);

  kj::Promise<void> request(
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, Response& response) override;

private:
  kj::HttpService& inner;
  kj::HttpHeaderTable& headerTable;
  kj::Url baseUrl;
  kj::String baseHostWithoutPort;
  WildcardMatcher wildcardHost;
  WildcardMatcher wildcardHostWithoutPort;

  bool maybeRedirect(kj::StringPtr url, const kj::HttpHeaders& headers, Response& response);
};

}  // namespace sandstorm

#endif // SANDSTORM_GATEWAY_H_
