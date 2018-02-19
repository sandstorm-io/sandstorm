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

static kj::String stripPort(kj::StringPtr hostport) {
  // We can't just search for a colon because of ipv6 literal addresses. We can only carefully
  // remove digits and then a : from the end.

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

GatewayService::Tables::Tables(kj::HttpHeaderTable::Builder& headerTableBuilder)
    : headerTable(headerTableBuilder.getFutureTable()),
      hAccessControlAllowOrigin(headerTableBuilder.add("Access-Control-Allow-Origin")),
      hAccessControlExposeHeaders(headerTableBuilder.add("Access-Control-Expose-Headers")),
      hAcceptLanguage(headerTableBuilder.add("Accept-Language")),
      hAuthorization(headerTableBuilder.add("Authorization")),
      hCacheControl(headerTableBuilder.add("Cache-Control")),
      hContentType(headerTableBuilder.add("Content-Type")),
      hContentLanguage(headerTableBuilder.add("Content-Language")),
      hContentEncoding(headerTableBuilder.add("Content-Encoding")),
      hCookie(headerTableBuilder.add("Cookie")),
      hDav(headerTableBuilder.add("Dav")),
      hLocation(headerTableBuilder.add("Location")),
      hOrigin(headerTableBuilder.add("Origin")),
      hUserAgent(headerTableBuilder.add("User-Agent")),
      hWwwAuthenticate(headerTableBuilder.add("WWW-Authenticate")),
      hXRealIp(headerTableBuilder.add("X-Real-IP")),
      hXSandstormPassthrough(headerTableBuilder.add("X-Sandstorm-Passthrough")),
      hXSandstormTokenKeepalive(headerTableBuilder.add("X-Sandstorm-Token-Keepalive")),
      bridgeTables(headerTableBuilder) {}

GatewayService::GatewayService(
    kj::Timer& timer, kj::HttpClient& shellHttp, GatewayRouter::Client router,
    Tables& tables, kj::StringPtr baseUrl, kj::StringPtr wildcardHost,
    kj::Maybe<kj::StringPtr> termsPublicId)
    : timer(timer), shellHttp(kj::newHttpService(shellHttp)), router(kj::mv(router)),
      tables(tables), baseUrl(kj::Url::parse(baseUrl, kj::Url::HTTP_PROXY_REQUEST)),
      wildcardHost(wildcardHost), termsPublicId(termsPublicId), tasks(*this) {}

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

    // TODO(perf): If we were more clever we could make these O(number of expired entries) rather
    //   than O(number of entries), but I doubt it matters.
    removeExpired(uiHosts, now, PURGE_PERIOD);
    removeExpired(apiHosts, now, PURGE_PERIOD);
    removeExpired(staticPublishers, now, PURGE_PERIOD);

    {
      auto iter = foreignHostnames.begin();
      while (iter != foreignHostnames.end()) {
        auto next = iter;
        ++next;
        if (iter->second.expires <= now) {
          foreignHostnames.erase(iter);
        }
        iter = next;
      }
    }

    return cleanupLoop();
  });
}

static constexpr kj::StringPtr MISSING_AUTHORIZATION_MESSAGE =
    "Missing or invalid authorization header.\n"
    "\n"
    "This address serves APIs, which allow external apps (such as a phone app) to\n"
    "access data on your Sandstorm server. This address is not meant to be opened\n"
    "in a regular browser.\n"_kj;

bool isAllowedBasicAuthUserAgent(kj::StringPtr ua) {
  // The "api" wildcard host (with no ID) can be used to access grain APIs, with routing being
  // based entirely on the token given in the Authorization header. However, because this endpoint
  // is shared by many grains, it is critical that a grain cannot serve HTML that is rendered by
  // the client. No browser sends "Authorization: Bearer <token>" when fetching HTML for rendering,
  // so this is fine so far. But we could like to allow API clients that insist on HTTP Basic Auth
  // rather than bearer tokens. But it's possible to convince a browser to use basic auth. So, we
  // can only allow basic auth if we're sure the client is not a browser. To that end, we check for
  // some known-good user agents.
  //
  // Eventually, we decided this wasn't scalable, and introduced API endpoints with unique IDs for
  // each grain. There, we can permit basic auth for all clients. We maintain this list for
  // backwards-compatibility only; it should never change.

  return ua.startsWith("git/")
      || ua.startsWith("GitHub-Hookshot/")
      || ua.startsWith("mirall/")
      || strstr(ua.cStr(), " mirall/") != nullptr
      || ua.startsWith("Mozilla/5.0 (iOS) ownCloud-iOS/")
      || ua.startsWith("Mozilla/5.0 (Android) ownCloud-android/")
      || ua.startsWith("litmus/");
}

kj::Promise<void> GatewayService::request(
    kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
    kj::AsyncInputStream& requestBody, Response& response) {
  KJ_ASSERT(isPurging, "forgot to call cleanupLoop()");

  kj::StringPtr host;
  KJ_IF_MAYBE(h, headers.get(kj::HttpHeaderId::HOST)) {
    host = *h;
  } else {
    return sendError(400, "Bad Request", response, "missing Host header");
  }

  KJ_IF_MAYBE(hostId, wildcardHost.match(host)) {
    if (*hostId == "ddp" || *hostId == "static" || *hostId == "payments") {
      // Specific hosts handled by shell.
      return shellHttp->request(method, url, headers, requestBody, response);
    } else if (*hostId == "api") {
      KJ_IF_MAYBE(token, getAuthToken(headers,
          isAllowedBasicAuthUserAgent(headers.get(tables.hUserAgent).orDefault("")))) {
        return handleApiRequest(*token, method, url, headers, requestBody, response);
      } else if (method == kj::HttpMethod::OPTIONS) {
        kj::HttpHeaders respHeaders(tables.headerTable);
        WebSessionBridge::addStandardApiOptions(tables.bridgeTables, headers, respHeaders);
        response.send(200, "OK", respHeaders, uint64_t(0));
      } else {
        return sendError(403, "Forbidden", response, MISSING_AUTHORIZATION_MESSAGE);
      }
    } else if (hostId->startsWith("api-")) {
      KJ_IF_MAYBE(token, getAuthToken(headers, true)) {
        // API session.
        return handleApiRequest(*token, method, url, headers, requestBody, response);
      } else {
        // Unauthenticated API host.
        if (method == kj::HttpMethod::GET || method == kj::HttpMethod::HEAD) {
          auto req = router.getApiHostResourceRequest();
          req.setHostId(hostId->slice(4));
          req.setPath(url);
          return req.send().then(
              [this,&response](capnp::Response<GatewayRouter::GetApiHostResourceResults> result) {
            kj::HttpHeaders respHeaders(tables.headerTable);

            if (result.hasResource()) {
              auto resource = result.getResource();
              if (resource.hasType()) {
                respHeaders.set(tables.hContentType, resource.getType());
              }
              if (resource.hasLanguage()) {
                respHeaders.set(tables.hContentLanguage, resource.getLanguage());
              }
              if (resource.hasEncoding()) {
                respHeaders.set(tables.hContentEncoding, resource.getEncoding());
              }

              auto body = resource.getBody();
              auto stream = response.send(200, "OK", respHeaders, body.size());
              auto promise = stream->write(body.begin(), body.size());
              return promise.attach(kj::mv(stream), kj::mv(result));
            } else {
              respHeaders.set(tables.hContentType, "text/plain");
              respHeaders.set(tables.hWwwAuthenticate, "Basic realm='Sandstorm API'");

              auto stream = response.send(
                  401, "Unauthorized", respHeaders, MISSING_AUTHORIZATION_MESSAGE.size());
              auto promise = stream->write(MISSING_AUTHORIZATION_MESSAGE.begin(),
                                           MISSING_AUTHORIZATION_MESSAGE.size());
              return promise.attach(kj::mv(stream));
            }
          });
        } else if (method == kj::HttpMethod::OPTIONS) {
          auto req = router.getApiHostOptionsRequest();
          req.setHostId(hostId->slice(4));
          return req.send().then([this,&headers,&response]
                (capnp::Response<GatewayRouter::GetApiHostOptionsResults> result) {
            kj::HttpHeaders respHeaders(tables.headerTable);
            WebSessionBridge::addStandardApiOptions(tables.bridgeTables, headers, respHeaders);
            if (result.hasDav()) {
              respHeaders.set(tables.hDav, kj::strArray(result.getDav(), ", "));
              respHeaders.set(tables.hAccessControlExposeHeaders, "DAV");
            }
            response.send(200, "OK", respHeaders, uint64_t(0));
          });
        } else {
          // Anything else requires authentication.
          return response.sendError(403, "Unauthorized", tables.headerTable);
        }
      }
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
        responseHeaders.add("Set-Cookie", kj::str(
            "sandstorm-sid=", parsed.query[0].value, "; HttpOnly",
            baseUrl.scheme == "https" ? "; Secure" : ""));
        responseHeaders.set(tables.hLocation, kj::mv(path));

        response.send(303, "See Other", responseHeaders, uint64_t(0));
        return kj::READY_NOW;
      }

      // Chrome and Safari (and hopefully others at some point) always send an Origin header on
      // cross-origin non-GET requests. Such requests directed to a UI host could only be CSRF
      // attacks. So, block them.
      KJ_IF_MAYBE(o, headers.get(tables.hOrigin)) {
        auto expected = kj::str(baseUrl.scheme, "://", host);
        if (*o != expected) {
          // Looks like an attack!
          if (*o == "null") {
            // TODO(security): Alas, it turns out we have apps that have:
            //   <meta name="referrer" content="no-referrer">
            // and Chrome sends "Origin: null" in these cases. :( These apps need to switch to:
            //   <meta name="referrer" content="same-origin">
            // It's important that we don't break apps, so we will accept null origins for now,
            // which of course completely defeats any CSRF protection.
            //
            // The affected apps appear to be limited to Etherpad and Gogs.
          } else {
            return sendError(403, "Unauthorized", response, "CSRF not allowed");
          }
        }
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
      return handleForeignHostname(host, method, url, headers, requestBody, response);
    }
  } else if (host == baseUrl.host) {
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

    // TODO(perf): Serve Meteor static assets directly, *unless* the server is in dev mode.

    // Fall back to shell.
    return shellHttp->request(method, url, headers, requestBody, response);
  } else {
    // Neither our base URL nor our wildcard URL. It's a foreign hostname.
    return handleForeignHostname(host, method, url, headers, requestBody, response);
  }
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

    auto basePath = kj::str(baseUrl.scheme, "://",
        KJ_ASSERT_NONNULL(headers.get(kj::HttpHeaderId::HOST)));
    params.setBasePath(basePath);
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
        [this,router = this->router,KJ_MVCAP(ownParams),KJ_MVCAP(sessionId),KJ_MVCAP(basePath),
         loadingFulfiller = kj::mv(loadingPaf.fulfiller)]() mutable
        -> capnp::Capability::Client {
      auto req = router.openUiSessionRequest();
      req.setSessionCookie(sessionId);
      req.setParams(ownParams);
      auto sent = req.send();
      if (loadingFulfiller->isWaiting()) {
        loadingFulfiller->fulfill(sent.getLoadingIndicator());
      }
      auto result = sent.getSession();
      return sent.then([this,&sessionId,&basePath]
                       (capnp::Response<GatewayRouter::OpenUiSessionResults>&& response)
                       -> capnp::Capability::Client {
        auto iter = uiHosts.find(sessionId);
        KJ_ASSERT(iter != uiHosts.end());
        iter->second.bridge->restrictParentFrame(response.getParentOrigin(), basePath);
        return response.getSession();
      }, [this,&sessionId](kj::Exception&& e) -> capnp::Capability::Client {
        // On error, invalidate the cached session immediately.
        uiHosts.erase(sessionId);
        kj::throwFatalException(kj::mv(e));
      });
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

kj::Maybe<kj::String> GatewayService::getAuthToken(
    const kj::HttpHeaders& headers, bool allowBasicAuth) {
  KJ_IF_MAYBE(auth, headers.get(tables.hAuthorization)) {
    if (strncasecmp(auth->cStr(), "bearer ", 7) == 0) {
      return kj::str(auth->slice(7));
    } else if (allowBasicAuth && strncasecmp(auth->cStr(), "basic ", 6) == 0) {
      auto decoded = kj::str(kj::decodeBase64(auth->slice(6)).asChars());
      KJ_IF_MAYBE(colonPos, decoded.findFirst(':')) {
        auto result = trim(decoded.slice(*colonPos + 1));
        // git likes to send a username with an empty password on the first try. We have to treat
        // this as a missing token and return 401 to convince it to send the password.
        if (result != nullptr) {
          return kj::mv(result);
        }
      }
    }
  }

  return nullptr;
}

kj::Promise<void> GatewayService::handleApiRequest(kj::StringPtr token,
    kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
    kj::AsyncInputStream& requestBody, Response& response) {
  KJ_IF_MAYBE(ka, headers.get(tables.hXSandstormTokenKeepalive)) {
    // Oh, it's a keepalive request.
    auto req = router.keepaliveApiTokenRequest();
    req.setApiToken(token);
    req.setDurationMs(ka->parseAs<uint64_t>());
    return req.send().then([this,&response](auto) {
      kj::HttpHeaders respHeaders(tables.headerTable);
      // TODO(cleanup): Should be 204 no content, but offer-template.html expects a 200.
      response.send(200, "OK", respHeaders, uint64_t(0));
    });
  } else {
    auto bridge = getApiBridge(token, headers);
    auto promise = bridge->request(method, url, headers, requestBody, response);
    return promise.attach(kj::mv(bridge));
  }
}

kj::Own<kj::HttpService> GatewayService::getApiBridge(
    kj::StringPtr token, const kj::HttpHeaders& headers) {
  kj::StringPtr ip = nullptr;
  KJ_IF_MAYBE(passthrough, headers.get(tables.hXSandstormPassthrough)) {
    bool allowAddress = false;
    for (auto part: split(*passthrough, ',')) {
      if (trim(part) == "address") {
        allowAddress = true;
      }
    }

    if (allowAddress) {
      ip = headers.get(tables.hXRealIp).orDefault(nullptr);
    }
  }

  auto ownKey = kj::str(ip, '/', token);
  token = ownKey.slice(ip.size() + 1);

  auto iter = apiHosts.find(ownKey);
  if (iter == apiHosts.end()) {
    capnp::MallocMessageBuilder requestMessage(128);
    auto params = requestMessage.getRoot<ApiSession::Params>();

    if (ip != nullptr) {
      if (ip.findFirst(':') != nullptr) {
        // Must be IPv6
        struct in6_addr addr6;
        if (inet_pton(AF_INET6, ip.cStr(), &addr6) > 0) {
          auto addr = params.initRemoteAddress();
          byte* b = addr6.s6_addr;
          addr.setUpper64((uint64_t(b[ 0]) << 56) | (uint64_t(b[ 1]) << 48)
                        | (uint64_t(b[ 2]) << 40) | (uint64_t(b[ 3]) << 32)
                        | (uint64_t(b[ 4]) << 24) | (uint64_t(b[ 5]) << 16)
                        | (uint64_t(b[ 6]) <<  8) | (uint64_t(b[ 7])      ));
          addr.setLower64((uint64_t(b[ 8]) << 56) | (uint64_t(b[ 9]) << 48)
                        | (uint64_t(b[10]) << 40) | (uint64_t(b[11]) << 32)
                        | (uint64_t(b[12]) << 24) | (uint64_t(b[13]) << 16)
                        | (uint64_t(b[14]) <<  8) | (uint64_t(b[15])      ));
        }
      } else {
        // Probably IPv4.
        struct in_addr addr4;
        if (inet_pton(AF_INET, ip.cStr(), &addr4) > 0) {
          params.initRemoteAddress()
              .setLower64(0x0000ffff00000000 | ntohl(addr4.s_addr));
        }
      }
    }

    auto ownParams = newOwnCapnp(params.asReader());

    WebSessionBridge::Options options;
    options.allowCookies = false;
    options.isHttps = baseUrl.scheme == "https";
    options.isApi = true;

    kj::StringPtr key = ownKey;

    // Use a CapRedirector to re-establish the session on disconenct.
    //
    // TODO(perf): This forces excessive copying of RPC requests and responses. We should add a
    //   ClientHook-based library to Cap'n Proto implementing the CapRedirector pattern more
    //   efficiently.
    capnp::Capability::Client sessionRedirector = kj::heap<CapRedirector>(
        [this,router = this->router,KJ_MVCAP(ownParams),KJ_MVCAP(ownKey),token]() mutable
        -> capnp::Capability::Client {
      auto req = router.openApiSessionRequest();
      req.setApiToken(token);
      req.setParams(ownParams);
      auto sent = req.send();
      auto result = sent.getSession();
      tasks.add(sent.then([](auto) {}, [this,key = kj::str(ownKey)](kj::Exception&& e) {
        // On error, invalidate the cached session immediately.
        apiHosts.erase(key);
      }));
      return result;
    });

    ApiHostEntry entry {
      timer.now(),
      kj::refcounted<WebSessionBridge>(sessionRedirector.castAs<WebSession>(), nullptr,
                                       tables.bridgeTables, options)
    };
    auto insertResult = apiHosts.insert(std::make_pair(key, kj::mv(entry)));
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

kj::Promise<void> GatewayService::handleForeignHostname(kj::StringPtr host,
    kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
    kj::AsyncInputStream& requestBody, Response& response) {
  auto hostname = stripPort(host);

  auto handleEntry = [this,method,url,&headers,&requestBody,&response,alreadyDone=false]
                     (ForeignHostnameEntry& entry) mutable -> kj::Promise<void> {
    if (alreadyDone) return kj::READY_NOW;

    switch (entry.info.which()) {
      case GatewayRouter::ForeignHostnameInfo::UNKNOWN: {
        auto message = unknownForeignHostnameError(entry.id);
        kj::HttpHeaders headers(tables.headerTable);
        headers.set(kj::HttpHeaderId::CONTENT_TYPE, "text/html; charset=UTF-8");
        auto stream = response.send(404, "Not Found", headers, message.size());
        auto promise = stream->write(message.begin(), message.size());
        return promise.attach(kj::mv(stream), kj::mv(message));
      }

      case GatewayRouter::ForeignHostnameInfo::STATIC_PUBLISHING:
        return getStaticPublished(entry.info.getStaticPublishing(), url, headers, response);

      case GatewayRouter::ForeignHostnameInfo::STANDALONE:
        // Serve Meteor shell app on standalone host.
        return shellHttp->request(method, url, headers, requestBody, response);
    }
    KJ_UNREACHABLE;
  };

  kj::Maybe<kj::Promise<void>> alreadyHandled;

  auto iter = foreignHostnames.find(hostname);
  auto now = timer.now();
  if (iter != foreignHostnames.end()) {
    if (iter->second.expires > now) {
      // We can use this entry.
      if (iter->second.refreshAfter > now || iter->second.currentlyRefreshing) {
        // Refresh not needed yet.
        return handleEntry(iter->second);
      } else {
        // We can use this entry but we need to initiate a refresh, too.
        alreadyHandled = handleEntry(iter->second);
        iter->second.currentlyRefreshing = true;
      }
    }
  }

  auto req = router.routeForeignHostnameRequest();
  req.setHostname(hostname);
  auto promise = req.send()
      .then([this,id=kj::str(hostname),now,handleEntry]
            (capnp::Response<GatewayRouter::RouteForeignHostnameResults>&& response) mutable {
    auto info = response.getInfo();
    ForeignHostnameEntry entry(kj::mv(id), info, now, info.getTtlSeconds() * kj::SECONDS);
    kj::StringPtr key = entry.id;
    auto insertResult = foreignHostnames.try_emplace(key, kj::mv(entry));
    if (!insertResult.second) {
      entry.id = kj::mv(insertResult.first->second.id);
      insertResult.first->second = kj::mv(entry);
    }
    return handleEntry(insertResult.first->second);
  });

  KJ_IF_MAYBE(ah, alreadyHandled) {
    tasks.add(kj::mv(promise));
    return kj::mv(*ah);
  } else {
    return kj::mv(promise);
  }
}

kj::String GatewayService::unknownForeignHostnameError(kj::StringPtr host) {
  return kj::str(
      "<style type=\"text/css\">h2, h3, p { max-width: 600px; }</style>"
      "<h2>Sandstorm static publishing needs further configuration (or wrong URL)</h2>\n"
      "<p>If you were trying to configure static publishing for a blog or website, powered "
      "by a Sandstorm app hosted at this server, you either have not added DNS TXT records "
      "correctly, or the DNS cache has not updated yet (may take a while, like 5 minutes to one "
      "hour).</p>\n"
      "<p>To visit this Sandstorm server's main interface, go to: <a href='", baseUrl, "'>",
      baseUrl, "</a></p>\n"
      "<h3>DNS details</h3>\n"
      "<p>No TXT records were found for the host: <code>sandstorm-www.", host, "</code></p>\n"
      "<p>If you have the <tt>dig</tt> tool, you can run this command to learn more:</p>\n"
      "<p><code>dig -t TXT sandstorm-www.", host, "</code></p>\n"
      "<h3>Changing the server URL, or troubleshooting OAuth login</h3>\n"
      "<p>If you are the server admin and want to use this address as the main interface, "
      "edit /opt/sandstorm/sandstorm.conf, modify the BASE_URL setting, and restart "
      "Sandstorm.</p>\n"
      "<p>If you got here after trying to log in via OAuth (e.g. through GitHub or Google), "
      "the problem is probably that the OAuth callback URL was set wrong. You need to "
      "update it through the respective login provider's management console. The "
      "easiest way to do that is to run <code>sudo sandstorm admin-token</code>, then "
      "reconfigure the OAuth provider.</p>\n");
}

void GatewayService::taskFailed(kj::Exception&& exception) {
  KJ_LOG(ERROR, exception);
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
