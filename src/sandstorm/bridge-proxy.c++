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

#include "bridge-proxy.h"
#include <map>
#include <sandstorm/api-session.capnp.h>
#include <sandstorm/bridge-proxy.capnp.h>
#include <capnp/compat/json.h>
#include <kj/debug.h>
#include <kj/encoding.h>
#include "util.h"
#include "web-session-bridge.h"

namespace sandstorm {
namespace {

kj::Maybe<kj::StringPtr> removePrefix(kj::StringPtr prefix, kj::StringPtr str) {
  if (str.startsWith(prefix)) {
    return str.slice(prefix.size());
  } else {
    return nullptr;
  }
}

class BridgeProxy final: public kj::HttpService {
public:
  BridgeProxy(SandstormApi<BridgeObjectId>::Client sandstormApi,
              SandstormHttpBridge::Client bridge,
              spk::BridgeConfig::Reader config,
              kj::HttpHeaderTable::Builder& headerTableBuilder)
      : sandstormApi(kj::mv(sandstormApi)),
        bridge(kj::mv(bridge)),
        config(config),
        hAuthorization(headerTableBuilder.add("Authorization")),
        headerTable(headerTableBuilder.getFutureTable()),
        webSessionBridgeTables(headerTableBuilder) {
  }

  kj::Promise<void> request(
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, Response& response) override {
    KJ_IF_MAYBE(pathStr, removePrefix("http://http-bridge/", url)) {
      KJ_REQUIRE(pathStr->findFirst('?') == nullptr, "unrecognized query string", url);
      auto path = KJ_MAP(part, split(*pathStr, '/')) { return kj::heapString(part); };

      if (path.size() > 2 && path[0] == "session" && path[2] == "claim" &&
          method == kj::HttpMethod::POST) {
        // POST /session/<id>/claim -- do a claimRequest().

        auto context = ({
          auto req = bridge.getSessionContextRequest();
          req.setId(path[1]);
          req.send().getContext();
        });

        return requestBody.readAllText()
            .then([this,KJ_MVCAP(context)](kj::String body) mutable
                -> kj::Promise<capnp::Response<SandstormApi<BridgeObjectId>::SaveResults>> {
          capnp::MallocMessageBuilder builder(128);
          auto parsedRequest = builder.initRoot<ProxyClaimRequestRequest>();
          capnp::JsonCodec json;
          json.decode(body, parsedRequest);

          auto req = context.claimRequestRequest();
          req.setRequestToken(parsedRequest.getRequestToken());

          auto permissionDefs = config.getViewInfo().getPermissions();
          auto requiredPerms = KJ_MAP(name, parsedRequest.getRequiredPermissions())
                                       -> kj::StringPtr { return name; };

          auto permArray = req.initRequiredPermissions(permissionDefs.size());

          for (size_t i: kj::indices(permissionDefs)) {
            auto defName = permissionDefs[i].getName();

            for (auto& reqName: requiredPerms) {
              if (reqName == defName) {
                permArray.set(i, true);
              }
            }
          }

          auto req2 = sandstormApi.saveRequest();
          req2.setCap(req.send().getCap());
          req2.setLabel(parsedRequest.getLabel());
          return req2.send();
        }).then([this,&response]
            (capnp::Response<SandstormApi<BridgeObjectId>::SaveResults>&& claim) {
          capnp::MallocMessageBuilder builder(64);
          auto root = builder.initRoot<ProxyClaimRequestResponse>();
          root.setCap(kj::encodeBase64(claim.getToken(), false));

          capnp::JsonCodec json;
          kj::String text = json.encode(root);

          kj::HttpHeaders headers(headerTable);
          headers.set(kj::HttpHeaderId::CONTENT_TYPE, "application/json; charset=UTF-8");
          auto stream = response.send(200, "OK", headers, text.size());
          auto promise = stream->write(text.begin(), text.size());
          return promise.attach(kj::mv(stream), kj::mv(text));
        });
      }
    }

    KJ_IF_MAYBE(auth, headers.get(hAuthorization)) {
      if (auth->startsWith("bearer ") || auth->startsWith("Bearer ")) {
        auto token = auth->slice(strlen("bearer "));
        auto service = getHttpSession(token);
        return dispatchToSession(kj::mv(service), method, url, headers, requestBody, response);
      }
    }

    return response.sendError(404, "Not Found", headerTable);
  }

  // TODO(someday): WebSocket

private:
  SandstormApi<BridgeObjectId>::Client sandstormApi;
  SandstormHttpBridge::Client bridge;
  spk::BridgeConfig::Reader config;

  kj::HttpHeaderId hAuthorization;
  kj::HttpHeaderTable& headerTable;

  WebSessionBridge::Tables webSessionBridgeTables;

  struct TokenInfo {
    TokenInfo(const TokenInfo&) = delete;
    TokenInfo(TokenInfo&&) = default;

    kj::String key;
    kj::Own<WebSessionBridge> service;
  };

  std::map<kj::StringPtr, TokenInfo> tokenMap;

  kj::Own<kj::HttpService> getHttpSession(kj::StringPtr token) {
    auto iter = tokenMap.find(token);
    if (iter == tokenMap.end()) {
      // Use a CapRedirector to automatically reconnect after disconnects. Keep in mind that due
      // to refcounting, the CapRedirector could outlive the BridgeProxy. Luckily it doesn't need
      // to capture "this".
      auto cap = capnp::Capability::Client(
          kj::heap<CapRedirector>([sandstormApi=sandstormApi,token=kj::str(token)]() mutable {
        auto req = sandstormApi.restoreRequest();
        req.setToken(kj::decodeBase64(token));
        return req.send().getCap();
      })).castAs<ApiSession>();

      TokenInfo info {
        kj::heapString(token),
        kj::refcounted<WebSessionBridge>(cap, webSessionBridgeTables, WebSessionBridge::Options())
      };
      auto result = kj::addRef(*info.service);
      kj::StringPtr key = info.key;
      tokenMap.insert(std::make_pair(key, kj::mv(info)));
      return kj::mv(result);
    } else {
      return kj::addRef(*iter->second.service);
    }
  }

  kj::Promise<void> dispatchToSession(kj::Own<kj::HttpService> service,
      kj::HttpMethod method, kj::StringPtr url, const kj::HttpHeaders& headers,
      kj::AsyncInputStream& requestBody, Response& response) {
    kj::StringPtr path;

    KJ_IF_MAYBE(p, removePrefix("http://", url)) {
      path = *p;
    } else KJ_IF_MAYBE(p, removePrefix("https://", url)) {
      path = *p;
    } else {
      KJ_FAIL_REQUIRE("unknown protocol", url);
    }

    KJ_IF_MAYBE(i, path.findFirst('/')) {
      path = path.slice(*i);
    } else {
      path = "/";
    }

    auto promise = service->request(method, path, headers, requestBody, response);
    return promise.attach(kj::mv(service));
  }
};

}  // namespace

kj::Own<kj::HttpService> newBridgeProxy(
    SandstormApi<BridgeObjectId>::Client sandstormApi,
    SandstormHttpBridge::Client bridge,
    spk::BridgeConfig::Reader config,
    kj::HttpHeaderTable::Builder& requestHeaders) {
  return kj::heap<BridgeProxy>(kj::mv(sandstormApi), kj::mv(bridge), config, requestHeaders);
}

} // namespace sandstorm
