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

  restore @5 (ref :SupervisorObjectId);
  # Wraps `MainView.restore()`. Can also restore capabilities hosted by the supervisor.

  drop @6 (ref :SupervisorObjectId);
  # Wraps `MainView.drop()`. Can also restore capabilities hosted by the supervisor.
}

interface SandstormCore {
  # When the front-end connects to a Sandstorm supervisor, it exports a SandstormCore capability as
  # the default capability on the connection. This SandstormCore instance is specific to the
  # supervisor's grain; e.g. the grain ID is used to enforce ownership restrictions in `restore()`
  # and to fill out the `grainId` field in the `ApiTokens` table in calls to `wrapSaved()`.
  #
  # If the front-end disconnects, it probably means that it is restarting. It will connect again
  # after restart. In the meantime, the supervisor should queue any RPCs to this interface and
  # retry them after the front-end has reconnected.

  restore @0 (token :Data) -> (cap :Capability);
  # Restores an API token to a live capability. Fails if this grain is not the token's owner
  # (including if the ref has no owner).

  drop @3 (token :Data);
  # Deletes the corresponding API token. See `MainView.drop()` for discussion of dropping.

  makeToken @1 (ref :SupervisorObjectId, owner :ApiTokenOwner) -> (token :Data);
  # When the supervisor receives a save() request for a capability hosted by the app, it first
  # calls save() on the underlying capability to get an AppObjectId, then calls makeToken() to
  # convert this to a token which it can then return.
  #
  # Similarly, when the supervisor receives a save() request for a capability it itself hosts
  # (outside of the app), it constructs the appropriate `SupervisorObjectId` and passes it to
  # `makeToken()`.
  #
  # TODO(soon): Someone needs to keep track of the Powerbox introduction that originally connected
  #   the client to the server, so that we can properly revoke this capability if the user's
  #   permissions change. For performance reasons (to avoid excess network hops), the supervisor
  #   (of the server) should keep track of this information. On restore() the supervisor should
  #   receive this information, it should maintain a membrane to track all capabilities introduced
  #   through the restored cap, and then on later save() it should associate the newly-saved object
  #   with the same Powerbox introduction. Similarly, expiration dates need to be propagated.

  getAdminNotificationTarget @2 () -> (owner :Grain.NotificationTarget);
  # Get the notification target to use for notifications relating to the grain itself, e.g.
  # presence of wake locks.
}

interface SystemPersistent extends(Persistent(Data, ApiTokenOwner)) {
  # The specialization of `Persistent` used in the "Sandstorm internal" realm, which is the realm
  # used by Sandstorm system components talking to each other. This realm is NOT seen by Sandstorm
  # applications; each grain is its own realm, and the Supervisor performs translations
  # transparently.
  #
  # In the Sandstorm internal realm, the type of SturdyRefs themselves is simply `Data`, where the
  # data is an API token. The SHA-256 hash of this token is an ID into the `ApiTokens` collection.
  # The token itself is arbitrary random bytes, not ASCII text (this differs from API tokens
  # created for the purpose of HTTP APIs).
}

struct ApiTokenOwner {
  # Defines who is permitted to use a particular API token.

  union {
    webkey @0 :Void;
    # This API token is for use on "the web", with no specific owner. This is the kind of token
    # that you get when you use the Sandstorm UI to create a webkey.
    #
    # Note that a webkey CANNOT be directly restored by an app, since this would break confinement
    # (an app could be shipped with a webkey baked in). Instead, the app must make a powerbox
    # request, and the user may paste in a webkey there. Apps can only restore tokens explicitly
    # owned by them.
    #
    # (HackSessionContext actually allows webkeys to be exchanged for live capabilities, but this
    # is temporary until the powerbox is built.)

    grain :group {
      # Owned by a local grain.

      grainId @1 :Text;
      # Grain ID owning the ref.

      saveLabel @2 :Util.LocalizedText;
      # As passed to `save()` in Sandstorm's Persistent interface.
    }

    internet @3 :AnyPointer;
    # An owner on the public internet, who used the Cap'n Proto public internet transport to call
    # `save()` and expects it to authenticate them on later `restore()`.
    #
    # TODO(someday): Change `AnyPointer` to the type for public internet owners, once the public
    #   internet Cap'n Proto protocol is defined. (Or, do we want Sandstorm nodes to be able to
    #   nested within broader networks that aren't the internet? Hmm.)

    frontend @4 :Void;
    # Owned by the front-end, i.e. stored in its Mongo database.
  }
}

struct SupervisorObjectId(AppObjectId) {
  # Refers to some persistent object which the Supervisor for a particular grain knows how to
  # restore.

  union {
    appRef @0 :AppObjectId;
    # A reference restorable by the app.

    wakeLockNotification @1 :UInt32;
    # This refers to an OngoingNotification for a wake lock. Note that although the app itself
    # implements an `OngoingNotification`, the supervisor wraps it in order to detect the `cancel`
    # call.
  }
}
