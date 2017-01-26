# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2017 Sandstorm Development Group, Inc. and contributors
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

@0xf963cc483d8f9e3a;
# This file defines some types used internally by sandstorm-http-bridge. App developers need not
# concern themselves with this code.

$import "/capnp/c++.capnp".namespace("sandstorm");
using Identity = import "identity.capnp";
using WebSession = import "web-session.capnp".WebSession;

struct BridgeObjectId {
  # The object ID format used by sandstorm-http-bridge.
  #
  # Recall that Sandstorm obfuscates object IDs automatically, such that clients cannot see the
  # contents and the app can trust that the ID passed from Sandstorm is authentic. Hence, we can
  # put all the metadata we need directly in this structure and let Sandstorm store it.

  union {
    application @0 :AnyPointer;
    # The object ID is in a format understood by the application, not by http-bridge.
    #
    # This is here to allow http-bridge-based applications to implement some APIs directly in
    # Cap'n Proto, or to transition entirely to the native API eventually while retaining backwards
    # compatibility.

    httpApi @1 :HttpApi;
    # An HTTP API, as defined using `BridgeConfig.PowerboxApi` (see `package.capnp`).
  }

  struct HttpApi {
    name @0 :Text;
    path @1 :Text;
    permissions @2 :Identity.PermissionSet;

    identityId @3 :Data;
    # Identity ID of the user who made the powerbox choice.
    #
    # TODO(someday): restore() should provide identity information so that we don't need this.
  }
}
