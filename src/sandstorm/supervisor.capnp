# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

@0xc7205d6d32c7b040;
# This file contains interfaces defining communication between a Sandstorm grain supervisor and
# other components of the sysetm. These interfaces are NOT used by Sandstorm applications.

$import "/capnp/c++.capnp".namespace("sandstorm");

using Util = import "util.capnp";
using Grain = import "grain.capnp";
using Persistent = import "/capnp/persistent.capnp".Persistent;

interface Supervisor {
  # Default capability exported by the supervisor process.

  getMainView @0 () -> (view :Grain.UiView);
  # Get the grain's main UiView.

  keepAlive @1 ();
  # Must call periodically to prevent supervisor from killing itself off.  Call at least once
  # per minute.

  shutdown @2 ();
  # Shut down the grain immediately.  Useful e.g. when upgrading to a newer app version.  This
  # call will never return successfully because the process kills itself.

  getGrainSize @3 () -> (size :UInt64);
  # Get the total storage size of the grain.

  getGrainSizeWhenDifferent @4 (oldSize :UInt64) -> (size :UInt64);
  # Wait until the storage size of the grain is different from `oldSize` and then return the new
  # size. May occasionally return prematurely, with `size` equal to `oldSize`.
}

interface SandstormCore(InternalSturdyRef, InternalOwner) {
  # When the front-end connects to a Sandstorm supervisor, it exports a SandstormCore capability as
  # the default capability on the connection.
  #
  # If the front-end disconnects, it probably means that it is restarting. It will connect again
  # after restart. In the meantime, the supervisor should queue any RPCs to this interface and
  # retry them after the front-end has reconnected.
  #
  # `InternalSturdyRef` is defined in `internal.capnp`, but is declared as a type parameter here
  # because the supervisor should treat this type as opaque.

  using Persistent = .Persistent(InternalSturdyRef, InternalOwner);

  restore @0 (ref :InternalSturdyRef) -> (cap :Persistent);
  # Restores a SturdyRef. Fails if this grain is not the ref's owner (including if the ref has no
  # owner).

  wrapSaved @1 [AppSturdyRef] (ref :AppSturdyRef, owner :InternalOwner)
      -> (internalRef :InternalSturdyRef);
  # When the supervisor receives a save() request for a capability hosted by the app, it first
  # calls save() on the underlying capability to get an AppSturdyRef, then calls wrapSaved() to
  # convert this to an InternalSturdyRef which it can then return.
  #
  # TODO(soon): How do we keep this capability associated with the user account that created it,
  #   in order to auto-revoke it if the user loses permissions?
}
