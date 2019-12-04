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

#ifndef SANDSTORM_BRIDGE_PROXY_H_
#define SANDSTORM_BRIDGE_PROXY_H_

#include <kj/compat/http.h>
#include <sandstorm/sandstorm-http-bridge.capnp.h>
#include <sandstorm/sandstorm-http-bridge-internal.capnp.h>
#include <sandstorm/package.capnp.h>

namespace sandstorm {

kj::Own<kj::HttpService> newBridgeProxy(
    kj::Timer& timer,
    SandstormApi<BridgeObjectId>::Client sandstormApi,
    SandstormHttpBridge::Client bridge,
    spk::BridgeConfig::Reader config,
    kj::HttpHeaderTable::Builder& requestHeaders);
// The BridgeProxy is a component of sandstorm-http-bridge that handles HTTP requests going in
// the opposite direction: originating from the app server and destined for the outside world.
//
// The bridge proxy emulates OAuth handshakes with a variety of well-known third-party services,
// and also allows grains to connect to each other.
//
// sandstorm-http-bridge automatically sets well-known environment variables to instruct the app
// to forward HTTP requests through it.

} // namespace sandstorm

#endif // SANDSTORM_BRIDGE_PROXY_H_
