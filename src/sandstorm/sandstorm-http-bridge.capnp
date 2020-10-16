# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014-2015 Sandstorm Development Group, Inc. and contributors
# All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

@0xac137d236832bb1e;
# This file defines interfaces that allow sandstorm-http-bridge to provide apps with access to
# Sandstorm platform features.

$import "/capnp/c++.capnp".namespace("sandstorm");
using Grain = import "grain.capnp";
using Identity = import "identity.capnp";
using Powerbox = import "powerbox.capnp";

interface SandstormHttpBridge {
  # Bootstrap interface provided to the app on a Unix domain socket at /tmp/sandstorm-api.

  getSandstormApi @0 () -> (api :Grain.SandstormApi);
  # Get the SandstormApi capability that was provided by the supervisor.

  getSessionContext @1 (id :Text) -> (context :Grain.SessionContext);
  # Get the SessionContext corresponding to a UiSession. The appropriate `id` value can be read
  # from the X-Sandstorm-Session-Id header inserted by sandstorm-http-bridge.

  getSessionRequest @4 (id :Text) -> (requestInfo :List(Powerbox.PowerboxDescriptor));
  # Get the requestInfo for a powerbox request session. The `id` parameter is the same as for
  # `getSessionContext`. This is only valid if the current session actually is a request
  # session. If it is, the `X-Sandstorm-Session-Type` header will be set to 'request'.

  getSessionOffer @5 (id :Text) -> (offer :Capability, descriptor :Powerbox.PowerboxDescriptor);
  # Get the offer information for a powerbox offer session. The `id` parameter is the same as
  # for `getSessionContext`. This is only valid if the current session actually is an offer
  # session. If it is, the `X-Sandstorm-Session-Type` header will be set to 'offer'.

  getSavedIdentity @2 (identityId :Text) -> (identity :Identity.Identity);
  # If BridgeConfig.saveIdentityCaps is true for this app, then you can call this method to fetch
  # the saved identity capability for a particular identityId as passed in the
  # `X-Sandstorm-User-Id` header.

  saveIdentity @3 (identity :Identity.Identity);
  # If BridgeConfig.saveIdentityCaps is true for this app, adds the given identity to the
  # grain's database, allowing it to be fetched later with `getSavedIdentity()`.
}

interface AppHooks (AppObjectId) {
  # When connecting to the bridge's domain socket at /tmp/sandstorm-api, the
  # application may supply this as a bootstrap interface. If the app chooses
  # to do so, it should also set `bridgeConfig.expectAppHooks = true` in the
  # package's PackageDefinition.
  #
  # The `AppObjectId` type parameter should be the same as that for any
  # objects exported by the app that implement Grain.AppPersistent.

  getViewInfo @0 () -> Grain.UiView.ViewInfo;
  # Like Grain.UiView.getViewInfo. If AppHooks is supplied, the bridge will
  # delegate UiView.getViewInfo to this method. If it raises unimplemented,
  # the bridge will fall back to reading the viewInfo from the bridgeConfig.

  restore @1 (objectId :AppObjectId) -> (cap :Capability);
  # Like Grain.MainView.restore. The bridge will use this to delegate restoring
  # any objects provided by the app, rather than the bridge itself. Such objects
  # must implement `Grain.AppPersistent.save` per the comments there and in
  # Grain.MainView.

  drop @2 (objectId :AppObjectId);
  # Like Grain.MainView.drop. See the comments for restore.
}
