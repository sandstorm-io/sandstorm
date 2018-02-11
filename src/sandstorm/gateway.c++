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
#include <kj/encoding.h>
#include <sandstorm/mime.capnp.h>
#include "util.h"
#include "smtp-proxy.h"
#include <sys/socket.h>
#include <arpa/inet.h>

namespace sandstorm {

static std::map<kj::StringPtr, kj::StringPtr> makeExtensionMap() {
  std::map<kj::StringPtr, kj::StringPtr> result;
  for (auto item: *MIME_TYPE_INFO_TABLE) {
    auto name = item.getName();
    for (auto ext: item.getExtensions()) {
      // It appears the list contains extensions prefixed with '*' to indicate that this mime type
      // can be associated with the extension but is not the preferred mime type for that
      // extension. So, we should only pay attention to the mapping that doesn't start with '*'.
      // (For some extensions, there are multiple '*' mappings, so if we don't filter them, we'll
      // fail the assert here...)
      if (!ext.startsWith("*")) {
        KJ_ASSERT(result.insert(std::make_pair(ext, name)).second, ext);
      }
    }
  }

  return result;
}

static const std::map<kj::StringPtr, kj::StringPtr>& extensionMap() {
  static const auto result = makeExtensionMap();
  return result;
}

GatewayService::Tables::Tables(kj::HttpHeaderTable::Builder& headerTableBuilder)
    : headerTable(headerTableBuilder.getFutureTable()),
      hAccessControlAllowOrigin(headerTableBuilder.add("Access-Control-Allow-Origin")),
      hAcceptLanguage(headerTableBuilder.add("Accept-Language")),
      hCacheControl(headerTableBuilder.add("Cache-Control")),
      hCookie(headerTableBuilder.add("Cookie")),
      hLocation(headerTableBuilder.add("Location")),
      hUserAgent(headerTableBuilder.add("User-Agent")),
      bridgeTables(headerTableBuilder) {}

GatewayService::GatewayService(
    kj::Timer& timer, kj::HttpClient& shellHttp, GatewayRouter::Client router,
    Tables& tables, kj::StringPtr baseUrl, kj::StringPtr wildcardHost,
    kj::Maybe<kj::StringPtr> termsPublicId)
    : timer(timer), shellHttp(kj::newHttpService(shellHttp)), router(kj::mv(router)),
      tables(tables), baseUrl(kj::Url::parse(baseUrl, kj::Url::HTTP_PROXY_REQUEST)),
      wildcardHost(wildcardHost), termsPublicId(termsPublicId) {}

template <typename Key, typename Value>
static void removeExpired(std::map<Key, Value>& m, kj::TimePoint now, kj::Duration period) {
  auto iter = m.begin();
  while (iter != m.end()) {
    auto next = iter;
    ++next;

    if (now - iter->second.lastUsed >= period) {
      m.erase(iter);
    }
    iter = next;
  }
}

kj::Promise<void> GatewayService::cleanupLoop() {
  static constexpr auto PURGE_PERIOD = 2 * kj::MINUTES;

  isPurging = true;
  return timer.afterDelay(PURGE_PERIOD).then([this]() {
    auto now = timer.now();
    removeExpired(uiHosts, now, PURGE_PERIOD);
    removeExpired(staticPublishers, now, PURGE_PERIOD);
    return cleanupLoop();
  });
}

kj::Promise<void> GatewayService::request(
    kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
    kj::AsyncInputStream& requestBody, Response& response) {
  KJ_ASSERT(isPurging, "forgot to call cleanupLoop()");

  KJ_IF_MAYBE(hostId, wildcardHost.match(headers)) {
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

        // TODO(cleanup): Powerbox requests seem to send a path that doesn't necessarily start
        //   with '/'. Why? Dunno. Fix.
        auto path = kj::mv(parsed.query[1].value);
        if (!path.startsWith("/")) {
          path = kj::str('/', path);
        }

        kj::HttpHeaders responseHeaders(tables.headerTable);
        // We avoid registering a header ID for Set-Cookie. See comments in web-session-bridge.c++.
        responseHeaders.add("Set-Cookie", kj::str("sandstorm-sid=", parsed.query[0].value));
        responseHeaders.set(tables.hLocation, kj::mv(path));

        response.send(303, "See Other", responseHeaders, uint64_t(0));
        return kj::READY_NOW;
      }

      auto headersCopy = kj::heap(headers.cloneShallow());
      KJ_IF_MAYBE(bridge, getUiBridge(*headersCopy)) {
        auto promise = bridge->get()->request(method, url, *headersCopy, requestBody, response);
        return promise.attach(kj::mv(*bridge), kj::mv(headersCopy));
      } else {
        return sendError(403, "Unauthorized", response,
            "Unauthorized due to missing cookie. Please make sure cookies\n"
            "are enabled, and that no settings or extensions are blocking\n"
            "cookies in iframes.\n"_kj);
      }
    } else if (hostId->size() == 20) {
      // Handle "public ID"
      auto promise = getStaticPublished(*hostId, url, headers, response);
      return promise.attach(kj::mv(*hostId));
    } else {
      // TODO(soon): Treat as custom domain, look up sandstorm-www txt record...
    }
  } else KJ_IF_MAYBE(host, headers.get(kj::HttpHeaderId::HOST)) {
    if (*host == baseUrl.host) {
      KJ_IF_MAYBE(tpi, termsPublicId) {
        auto parsedUrl = kj::Url::parse(url, kj::Url::HTTP_REQUEST);
        if (parsedUrl.path.size() > 0 &&
            (parsedUrl.path[0] == "terms" || parsedUrl.path[0] == "privacy")) {
          // Request for /terms or /privacy, and we've configured a special public ID for that.
          // (This is a backwards-compatibility hack mainly for Sandstorm Oasis, where an nginx
          // proxy used to map these paths to static assets, but we want to replace nginx entirely
          // with the gateway.)
          kj::String ownUrl;
          if (parsedUrl.path.size() == 1 && !parsedUrl.hasTrailingSlash) {
            // Extra special hack: Fake a ".html" extension for MIME type sniffing.
            ownUrl = kj::str("/", parsedUrl.path[0], ".html");
            url = ownUrl;
          }
          return getStaticPublished(*tpi, url, headers, response);
        }
      }
    }
  }

  // TODO(perf): Serve Meteor static assets directly, *unless* the server is in dev mode.

  // Fall back to shell.
  return shellHttp->request(method, url, headers, requestBody, response);
}

kj::Promise<void> GatewayService::openWebSocket(
    kj::StringPtr url, const kj::HttpHeaders& headers, WebSocketResponse& response) {
  KJ_IF_MAYBE(hostId, wildcardHost.match(headers)) {
    if (hostId->startsWith("api-")) {
      // TODO(soon): API hosts.
    } else if (hostId->startsWith("ui-")) {
      auto headersCopy = kj::heap(headers.cloneShallow());
      KJ_IF_MAYBE(bridge, getUiBridge(*headersCopy)) {
        auto promise = bridge->get()->openWebSocket(url, *headersCopy, response);
        return promise.attach(kj::mv(bridge), kj::mv(headersCopy));
      } else {
        return sendError(403, "Unauthorized", response,
            "Unauthorized due to missing cookie. Please make sure cookies\n"
            "are enabled, and that no settings or extensions are blocking\n"
            "cookies in iframes.\n"_kj);
      }
    }
  }

  // Fall back to shell.
  return shellHttp->openWebSocket(url, headers, response);
}

kj::Promise<void> GatewayService::sendError(
    uint statusCode, kj::StringPtr statusText, Response& response, kj::StringPtr message) {
  kj::HttpHeaders respHeaders(tables.headerTable);
  respHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "text/plain; charset=UTF-8");
  auto stream = response.send(403, "Unauthorized", respHeaders, message.size());
  auto promise = stream->write(message.begin(), message.size());
  return promise.attach(kj::mv(stream));
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

kj::String WildcardMatcher::makeHost(kj::StringPtr hostId) {
  return kj::str(prefix, hostId, suffix);
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

    auto loadingPaf = kj::newPromiseAndFulfiller<Handle::Client>();

    // Use a CapRedirector to re-establish the session on disconenct.
    //
    // TODO(perf): This forces excessive copying of RPC requests and responses. We should add a
    //   ClientHook-based library to Cap'n Proto implementing the CapRedirector pattern more
    //   efficiently.
    capnp::Capability::Client sessionRedirector = kj::heap<CapRedirector>(
        [router = this->router,KJ_MVCAP(ownParams),KJ_MVCAP(sessionId),
         loadingFulfiller = kj::mv(loadingPaf.fulfiller)]() mutable
        -> capnp::Capability::Client {
      auto req = router.openUiSessionRequest();
      req.setSessionCookie(sessionId);
      req.setParams(ownParams);
      auto sent = req.send();
      if (loadingFulfiller->isWaiting()) {
        loadingFulfiller->fulfill(sent.getLoadingIndicator());
      }
      return sent.getSession();
    });

    UiHostEntry entry {
      timer.now(),
      kj::refcounted<WebSessionBridge>(sessionRedirector.castAs<WebSession>(),
                                       Handle::Client(kj::mv(loadingPaf.promise)),
                                       tables.bridgeTables, options)
    };
    auto insertResult = uiHosts.insert(std::make_pair(key, kj::mv(entry)));
    KJ_ASSERT(insertResult.second);
    iter = insertResult.first;
  } else {
    iter->second.lastUsed = timer.now();
  }

  return kj::addRef(*iter->second.bridge);
}

kj::Promise<void> GatewayService::getStaticPublished(
    kj::StringPtr publicId, kj::StringPtr path, const kj::HttpHeaders& headers,
    kj::HttpService::Response& response, uint retryCount) {
  kj::StringPtr originalPath = path;

  static uint generationCounter = 0;

  auto iter = staticPublishers.find(publicId);

  if (iter == staticPublishers.end()) {
    auto req = router.getStaticPublishingHostRequest();
    req.setPublicId(publicId);

    StaticPublisherEntry entry {
      kj::str(publicId),
      generationCounter++,
      timer.now(),
      req.send().getSupervisor()
    };

    kj::StringPtr key = entry.id;

    auto result = staticPublishers.insert(std::make_pair(key, kj::mv(entry)));
    KJ_ASSERT(result.second);
    iter = result.first;
  } else {
    iter->second.lastUsed = timer.now();
  }

  kj::String ownPath;

  // Strip query.
  KJ_IF_MAYBE(pos, path.findLast('?')) {
    ownPath = kj::str(path.slice(0, *pos));
    path = ownPath;
  }

  // If a directory, open "index.html".
  if (path.endsWith("/")) {
    ownPath = kj::str(path, "index.html");
    path = ownPath;
  }

  // Strip leading "/".
  KJ_ASSERT(path.startsWith("/"));
  path = path.slice(1);

  // URI-decode the rest. Note that this allows filenames to contain spaces and question marks.
  ownPath = kj::decodeUriComponent(path);
  path = ownPath;

  kj::HttpHeaders responseHeaders(tables.headerTable);

  // Infer MIME type from content.
  KJ_IF_MAYBE(dotpos, path.findLast('.')) {
    auto& exts = extensionMap();
    auto iter = exts.find(path.slice(*dotpos + 1));
    if (iter != exts.end()) {
      kj::StringPtr type = iter->second;
      if (type.startsWith("text/") ||
          type == "application/json" ||
          type == "application/xml" ||
          type.endsWith("+json") ||
          type.endsWith("+xml")) {
        // Probably text.
        responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, kj::str(type, "; charset=UTF-8"));
      } else {
        responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, type);
      }
    } else {
      responseHeaders.set(kj::HttpHeaderId::CONTENT_TYPE, "application/octet-stream");
    }
  }

  responseHeaders.set(tables.hCacheControl, "public, max-age=30");

  if (path == "apps/index.json" ||
      (path.size() == 62 && path.startsWith("apps/") && path.endsWith(".json")) ||
      path == "experimental/index.json" ||
      (path.size() == 70 && path.startsWith("experimental/") && path.endsWith(".json"))) {
    // TODO(cleanup): Extra special terrible hack: The app index needs to serve these JSON files
    //   cross-origin. We could almost just make all web sites allow cross-origin since generally
    //   web publishing is meant to publish public content. There is one case where this is
    //   problematic, though: sites behind a firewall. Those sites could potentially be read
    //   by outside sites if CORS is enabled on them. Some day we should make it so apps can
    //   explicitly opt-in to allowing cross-origin queries but that day is not today.
    responseHeaders.set(tables.hAccessControlAllowOrigin, "*");
  }

  // TODO(perf): Automatically gzip text content? (Check Accept-Encoding header first.)

  auto req = iter->second.supervisor.getWwwFileHackRequest();
  req.setPath(path);
  auto streamAndAborter = WebSessionBridge::makeHttpResponseStream(
      200, "OK", kj::mv(responseHeaders), response);
  req.setStream(kj::mv(streamAndAborter.stream));

  uint oldGeneration = iter->second.generation;

  return req.send()
      .then([this,&response,path](capnp::Response<Supervisor::GetWwwFileHackResults>&& result)
          -> kj::Promise<void> {
    switch (result.getStatus()) {
      case Supervisor::WwwFileStatus::FILE:
        // Done already.
        return kj::READY_NOW;
      case Supervisor::WwwFileStatus::DIRECTORY: {
        kj::HttpHeaders headers(tables.headerTable);
        auto newPath = kj::str(path, '/');
        auto body = kj::str("redirect: ", newPath);
        headers.set(kj::HttpHeaderId::CONTENT_TYPE, "text/plain; charset=UTF-8");
        headers.set(kj::HttpHeaderId::LOCATION, kj::mv(newPath));
        headers.set(tables.hCacheControl, "public, max-age=30");
        auto stream = response.send(303, "See Other", headers, uint64_t(0));
        auto promise = stream->write(body.begin(), body.size());
        return promise.attach(kj::mv(body));
      }
      case Supervisor::WwwFileStatus::NOT_FOUND:
        return response.sendError(404, "Not Found", tables.headerTable);
    }

    KJ_UNREACHABLE;
  }).attach(kj::mv(ownPath), kj::mv(streamAndAborter.aborter))
      .catch_([this,publicId,originalPath,&headers,&response,retryCount,oldGeneration]
              (kj::Exception&& e) -> kj::Promise<void> {
    if (e.getType() == kj::Exception::Type::DISCONNECTED && retryCount < 2) {
      auto iter = staticPublishers.find(publicId);
      if (iter != staticPublishers.end() && iter->second.generation == oldGeneration) {
        staticPublishers.erase(iter);
      }
      return getStaticPublished(publicId, originalPath, headers, response, retryCount + 1);
    } else {
      return kj::mv(e);
    }
  });
}

// =======================================================================================

GatewayTlsManager::GatewayTlsManager(
    kj::HttpServer& server, kj::NetworkAddress& smtpServer,
    kj::Maybe<kj::StringPtr> privateKeyPassword, kj::PromiseFulfillerPair<void> readyPaf)
    : server(server),
      smtpServer(smtpServer),
      privateKeyPassword(privateKeyPassword),
      ready(readyPaf.promise.fork()),
      readyFulfiller(kj::mv(readyPaf.fulfiller)),
      tasks(*this) {}

kj::Promise<void> GatewayTlsManager::listenHttps(kj::ConnectionReceiver& port) {
  return ready.addBranch().then([this, &port]() {
    return listenLoop(port);
  });
}

kj::Promise<void> GatewayTlsManager::listenSmtp(kj::ConnectionReceiver& port) {
  return ready.addBranch().then([this, &port]() {
    return listenSmtpLoop(port);
  });
}

kj::Promise<void> GatewayTlsManager::listenSmtps(kj::ConnectionReceiver& port) {
  return ready.addBranch().then([this, &port]() {
    return listenSmtpsLoop(port);
  });
}

void GatewayTlsManager::setKeys(kj::StringPtr key, kj::StringPtr certChain) {
  KJ_LOG(INFO, "Loading TLS key into Gateway");

  kj::TlsKeypair keypair {
    kj::TlsPrivateKey(key, privateKeyPassword),
    kj::TlsCertificate(certChain)
  };

  kj::TlsContext::Options options;
  options.useSystemTrustStore = false;
  options.defaultKeypair = keypair;

  currentTls = kj::refcounted<RefcountedTlsContext>(options);
  readyFulfiller->fulfill();
}

void GatewayTlsManager::unsetKeys() {
  currentTls = nullptr;
  readyFulfiller->fulfill();
}

class GatewayTlsManager::TlsKeyCallbackImpl: public GatewayRouter::TlsKeyCallback::Server {
public:
  TlsKeyCallbackImpl(GatewayTlsManager& parent): parent(parent) {}

protected:
  kj::Promise<void> setKeys(SetKeysContext context) override {
    auto params = context.getParams();
    if (params.hasKey()) {
      parent.setKeys(params.getKey(), params.getCertChain());
    } else {
      parent.unsetKeys();
    }
    return kj::READY_NOW;
  }

private:
  GatewayTlsManager& parent;
};

kj::Promise<void> GatewayTlsManager::subscribeKeys(GatewayRouter::Client gatewayRouter) {
  auto req = gatewayRouter.subscribeTlsKeysRequest();
  req.setCallback(kj::heap<TlsKeyCallbackImpl>(*this));
  return req.send().then([](auto) -> kj::Promise<void> {
    KJ_FAIL_REQUIRE("subscribeTlsKeys() shouldn't return");
  }, [this, gatewayRouter = kj::mv(gatewayRouter)]
      (kj::Exception&& exception) mutable -> kj::Promise<void> {
    if (exception.getType() == kj::Exception::Type::DISCONNECTED) {
      return subscribeKeys(kj::mv(gatewayRouter));
    } else {
      return kj::mv(exception);
    }
  });
}

kj::Promise<void> GatewayTlsManager::listenLoop(kj::ConnectionReceiver& port) {
  return port.accept().then([this, &port](kj::Own<kj::AsyncIoStream>&& stream) {
    KJ_IF_MAYBE(t, currentTls) {
      auto tls = kj::addRef(**t);
      tasks.add(tls->tls.wrapServer(kj::mv(stream))
          .then([this](kj::Own<kj::AsyncIoStream>&& encrypted) {
        return server.listenHttp(kj::mv(encrypted));
      }).attach(kj::mv(tls)));
    } else {
      KJ_LOG(ERROR, "refused HTTPS connection because no TLS keys are configured");
    }
    return listenLoop(port);
  });
}

kj::Promise<void> GatewayTlsManager::listenSmtpLoop(kj::ConnectionReceiver& port) {
  return port.accept().then([this, &port](kj::Own<kj::AsyncIoStream>&& stream) {
    KJ_IF_MAYBE(t, currentTls) {
      auto tls = kj::addRef(**t);
      tasks.add(proxySmtp(tls->tls, kj::mv(stream), smtpServer).attach(kj::mv(tls)));
    } else {
      // No keys configured. Accept SMTP without STARTTLS support.
      tasks.add(smtpServer.connect()
          .then([stream=kj::mv(stream)](kj::Own<kj::AsyncIoStream>&& server) mutable {
        return pumpDuplex(kj::mv(stream), kj::mv(server));
      }));
    }
    return listenSmtpLoop(port);
  });
}

kj::Promise<void> GatewayTlsManager::listenSmtpsLoop(kj::ConnectionReceiver& port) {
  return port.accept().then([this, &port](kj::Own<kj::AsyncIoStream>&& stream) {
    KJ_IF_MAYBE(t, currentTls) {
      auto tls = kj::addRef(**t);
      auto& tlsRef = tls->tls;
      tasks.add(tls->tls.wrapServer(kj::mv(stream))
          .then([this,&tlsRef](kj::Own<kj::AsyncIoStream>&& encrypted) {
        return smtpServer.connect()
            .then([this,&tlsRef,encrypted=kj::mv(encrypted)]
                  (kj::Own<kj::AsyncIoStream>&& server) mutable {
          return pumpDuplex(kj::mv(encrypted), kj::mv(server));
        });
      }).attach(kj::mv(tls)));
    } else {
      KJ_LOG(ERROR, "refused SMTPS connection because no TLS keys are configured");
    }
    return listenSmtpsLoop(port);
  });
}

void GatewayTlsManager::taskFailed(kj::Exception&& exception) {
  if (exception.getType() != kj::Exception::Type::DISCONNECTED) {
    KJ_LOG(ERROR, exception);
  }
}

// =======================================================================================

RealIpService::RealIpService(kj::HttpService& inner,
                             kj::HttpHeaderId hXRealIp,
                             kj::AsyncIoStream& connection)
    : inner(inner), hXRealIp(hXRealIp) {
  struct sockaddr_storage addr;
  memset(&addr, 0, sizeof(addr));
  uint len = sizeof(addr);
  connection.getpeername(reinterpret_cast<struct sockaddr*>(&addr), &len);

  if (addr.ss_family == AF_INET || addr.ss_family == AF_INET6) {
    // We trust the client to provide their own X-Real-IP if the client's address is a private
    // network address, since this likely means the client is a reverse proxy like nginx. Also,
    // client IP addresses are only really used for analytics, so there's not much damage that can
    // be done by spoofing, and a private network address is not useful for analytics anyhow.
    void* innerAddr = nullptr;
    if (addr.ss_family == AF_INET) {
      uint8_t addr4[4];
      auto sinAddr = &reinterpret_cast<struct sockaddr_in*>(&addr)->sin_addr;
      innerAddr = sinAddr;
      memcpy(addr4, &sinAddr->s_addr, 4);
      trustClient = addr4[0] == 127 || addr4[0] == 10
                 || (addr4[0] == 192 && addr4[1] == 168)
                 || (addr4[0] == 169 && addr4[1] == 254)
                 || (addr4[0] == 172 && addr4[1] >= 16 && addr4[1] < 32);
    } else if (addr.ss_family == AF_INET6) {
      auto sin6Addr = &reinterpret_cast<struct sockaddr_in6*>(&addr)->sin6_addr;
      innerAddr = sin6Addr;
      uint8_t* addr6 = sin6Addr->s6_addr;
      static constexpr uint8_t LOCAL6[16] = {0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1};
      trustClient = addr6[0] == 0xfc || addr6[0] == 0xfd
                 || (addr6[0] == 0xfe && (addr6[1] & 0xc0) == 0x80)
                 || memcmp(addr6, LOCAL6, 16) == 0;
    }

    KJ_ASSERT(innerAddr != nullptr);

    char buffer[INET6_ADDRSTRLEN];
    inet_ntop(addr.ss_family, innerAddr, buffer, sizeof(buffer));
    address = kj::str(buffer);
  } else {
    trustClient = addr.ss_family == AF_UNIX;
  }
}

kj::Promise<void> RealIpService::request(
    kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
    kj::AsyncInputStream& requestBody, Response& response) {
  if (trustClient && (address == nullptr || headers.get(hXRealIp) != nullptr)) {
    // Nothing to change, because we trust the client, and either the client provided an X-Real-IP,
    // or we don't have any other value to use anyway.
    return inner.request(method, url, headers, requestBody, response);
  } else {
    auto copy = kj::heap<kj::HttpHeaders>(headers.clone());
    KJ_IF_MAYBE(a, address) {
      copy->set(hXRealIp, *a);
    } else {
      copy->unset(hXRealIp);
    }
    auto promise = inner.request(method, url, *copy, requestBody, response);
    return promise.attach(kj::mv(copy));
  }
}

kj::Promise<void> RealIpService::openWebSocket(
    kj::StringPtr url, const kj::HttpHeaders& headers, WebSocketResponse& response) {
  if (trustClient && (address == nullptr || headers.get(hXRealIp) != nullptr)) {
    // Nothing to change, because we trust the client, and either the client provided an X-Real-IP,
    // or we don't have any other value to use anyway.
    return inner.openWebSocket(url, headers, response);
  } else {
    auto copy = kj::heap<kj::HttpHeaders>(headers.clone());
    KJ_IF_MAYBE(a, address) {
      copy->set(hXRealIp, *a);
    } else {
      copy->unset(hXRealIp);
    }
    auto promise = inner.openWebSocket(url, *copy, response);
    return promise.attach(kj::mv(copy));
  }
}

// =======================================================================================

AltPortService::AltPortService(kj::HttpService& inner, kj::HttpHeaderTable& headerTable,
                               kj::StringPtr baseUrlParam, kj::StringPtr wildcardHost)
    : inner(inner), headerTable(headerTable),
      baseUrl(kj::Url::parse(baseUrlParam)),
      baseHostWithoutPort(stripPort(baseUrl.host)),
      wildcardHost(kj::str(wildcardHost)),
      wildcardHostWithoutPort(stripPort(wildcardHost)) {}

kj::Promise<void> AltPortService::request(
    kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
    kj::AsyncInputStream& requestBody, Response& response) {
  if (maybeRedirect(url, headers, response)) {
    return kj::READY_NOW;
  } else {
    return inner.request(method, url, headers, requestBody, response);
  }
}

kj::Promise<void> AltPortService::openWebSocket(
    kj::StringPtr url, const kj::HttpHeaders& headers, WebSocketResponse& response) {
  if (maybeRedirect(url, headers, response)) {
    return kj::READY_NOW;
  } else {
    return inner.openWebSocket(url, headers, response);
  }
}

kj::String AltPortService::stripPort(kj::StringPtr hostport) {
  for (const char* ptr = hostport.end(); ptr != hostport.begin(); --ptr) {
    if (ptr[-1] == ':' && *ptr != '\0') {
      // Saw port!
      return kj::str(kj::arrayPtr(hostport.begin(), ptr - 1));
    }

    if (ptr[-1] < '0' || '9' < ptr[-1]) {
      // Not a digit, can't be part of port.
      break;
    }
  }

  // Did not find a port; just return the whole thing.
  return kj::str(hostport);
}

bool AltPortService::maybeRedirect(kj::StringPtr url, const kj::HttpHeaders& headers,
                                   Response& response) {
  KJ_IF_MAYBE(host, headers.get(kj::HttpHeaderId::HOST)) {
    auto stripped = stripPort(*host);
    if (stripped == baseHostWithoutPort) {
      KJ_ASSERT(url.startsWith("/"));
      kj::HttpHeaders responseHeaders(headerTable);
      responseHeaders.set(kj::HttpHeaderId::LOCATION,
          kj::str(baseUrl.scheme, "://", baseUrl.host, url));
      response.send(301, "Moved Permanently", responseHeaders, uint64_t(0));
      return true;
    } else KJ_IF_MAYBE(hostId, wildcardHostWithoutPort.match(stripped)) {
      KJ_ASSERT(url.startsWith("/"));
      kj::HttpHeaders responseHeaders(headerTable);
      responseHeaders.set(kj::HttpHeaderId::LOCATION,
          kj::str(baseUrl.scheme, "://", wildcardHost.makeHost(*hostId), url));
      response.send(301, "Moved Permanently", responseHeaders, uint64_t(0));
      return true;
    }
  }

  return false;
}

}  // namespace sandstorm
