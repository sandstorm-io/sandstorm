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

interface SandstormHttpBridge {
  # Bootstrap interface provided to the app on a Unix domain socket at /tmp/sandstorm-api.

  getSandstormApi @0 () -> (api :Grain.SandstormApi);
  # Get the SandstormApi capability that was provided by the supervisor.

  getSessionContext @1 (id :Text) -> (context :Grain.SessionContext);
  # Get the SessionContext corresponding to a UiSession. The appropriate `id` value can be read
  # from the X-Sandstorm-Session-Id header inserted by sandstorm-http-bridge.
}
