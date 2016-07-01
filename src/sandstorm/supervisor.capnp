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
# other components of the system. These interfaces are NOT used by Sandstorm applications.

$import "/capnp/c++.capnp".namespace("sandstorm");

using Util = import "util.capnp";
using Grain = import "grain.capnp";
using Persistent = import "/capnp/persistent.capnp".Persistent;

interface Supervisor {
  # Default capability exported by the supervisor process.

  getMainView @0 () -> (view :Grain.UiView);
  # Get the grain's main UiView.

  keepAlive @1 (core :SandstormCore);
  # Must call periodically to prevent supervisor from killing itself off.  Call at least once
  # per minute.
  #
  # `core` may be null. If not null, then it is a new copy of the SandstormCore capability which
  # should replace the old one. This allows the grain to recover if the original SandstormCore
  # becomes disconnected.
  #
  # TODO(reliability): Passing `core` here is an ugly hack. The supervisor really needs a way to
  #   proactively reconnect.

  syncStorage @8 ();
  # Calls syncfs() on /var.

  shutdown @2 ();
  # Shut down the grain immediately.  Useful e.g. when upgrading to a newer app version.  This
  # call will never return successfully because the process kills itself.

  getGrainSize @3 () -> (size :UInt64);
  # Get the total storage size of the grain.

  getGrainSizeWhenDifferent @4 (oldSize :UInt64) -> (size :UInt64);
  # Wait until the storage size of the grain is different from `oldSize` and then return the new
  # size. May occasionally return prematurely, with `size` equal to `oldSize`.

  restore @5 (ref :SupervisorObjectId, requirements :List(MembraneRequirement), parentToken :Data)
          -> (cap :Capability);
  # Wraps `MainView.restore()`. Can also restore capabilities hosted by the supervisor.
  #
  # `requirements` lists any conditions which, if they become untrue, should cause the capability --
  # and any future capabilities which pass through it -- to be revoked. The supervisor creates a
  # membrane around the returned capability which will be revoked if any of these requirements
  # fail. Additionally, the membrane will ensure that any capabilities save()d after passing
  # through this membrane have these requirements applied as well.
  #
  # (Typically, `requirements` is empty or contains one entry: a `permissionsHeld` requirement
  # against the grain that is restoring the capability (in order to implement the
  # `requiredPermissions` argument of SandstormCore.restore()). `requirements` should NOT contain
  # a requirement that `parentToken` be valid; this is implied.)
  #
  # `parentToken` is the API token restored to get this capability. The receiver will want to keep
  # this in memory in order to pass to `SandstormCore.makeChildToken()` later, if the live
  # capability is saved again.

  drop @6 (ref :SupervisorObjectId);
  # Wraps `MainView.drop()`. Can also drop capabilities hosted by the supervisor.

  watchLog @7 (backlogAmount :UInt64, stream :Util.ByteStream) -> (handle :Util.Handle);
  # Write the last `backlogAmount` bytes of the grain's debug log to `stream`, and then watch the
  # log for changes, writing them to `stream` as they happen, until `handle` is dropped.

  enum WwwFileStatus {
    file @0;
    directory @1;
    notFound @2;
  }

  getWwwFileHack @9 (path :Text, stream :Util.ByteStream) -> (status :WwwFileStatus);
  # Reads a file from under the grain's "/var/www" directory. If the path refers to a regular
  # file, the contents are written to `stream`, and `status` is returned as `file`. If the path
  # refers to a directory or is not found, then `stream` is NOT called at all and the method
  # returns the corresponding status.
  #
  # Note that if a Supervisor capability is obtained and used only for `getWwwFileHack()` -- i.e.
  # `getMainView()` and `restore()` are not called -- then the supervisor will not actually start
  # the application.
  #
  # This method is a temporary hack designed so that Sandstorm's front-end can implement web
  # publishing -- as defined by HackSessionContext -- without digging directly into the grain's
  # storage on-disk. Eventually, this mechanism for web publishing will be eliminated entirely
  # and replaced with a driver and powerbox interactions.
}

interface SandstormCore {
  # When the front-end connects to a Sandstorm supervisor, the front-end exports a SandstormCore
  # capability as the default capability on the connection. This SandstormCore instance is specific
  # to the supervisor's grain; e.g. the grain ID is used to enforce ownership restrictions in
  # `restore()` and to fill out the `grainId` field in the `ApiTokens` table in calls to
  # `wrapSaved()`.
  #
  # If the front-end disconnects, this probably means that it is restarting. It will connect again
  # after restart. In the meantime, the supervisor should queue any RPCs to this interface and
  # retry them after the front-end has reconnected.

  restore @0 (token :Data) -> (cap :Capability);
  # Restores an API token to a live capability. Fails if this grain is not the token's owner
  # (including if the ref has no owner).

  claimRequest @6 (requestToken :Text, requiredPermissions :Grain.PermissionSet)
               -> (cap :Capability);
  # Restores a client powerbox request token to a live capability, which can then be saved to get
  # a proper sturdyref.
  #
  # `requiredPermissions` has the same meaning as in SandstormApi.claimRequest(). Note that the
  # callee will not only check these requirements, but will automatically ensure that the returned
  # capability has an appropriate `MembraneRequirement` applied; the caller need not concern
  # itself with this.

  drop @3 (token :Data);
  # Deletes the corresponding API token. See `MainView.drop()` for discussion of dropping.

  makeToken @1 (ref :SupervisorObjectId, owner :ApiTokenOwner,
                requirements :List(MembraneRequirement)) -> (token :Data);
  # When the supervisor receives a save() request for a capability hosted by the app, it first
  # calls save() on the underlying capability to get an AppObjectId, then calls makeToken() to
  # convert this to a token which it can then return.
  #
  # Similarly, when the supervisor receives a save() request for a capability it itself hosts
  # (outside of the app), it constructs the appropriate `SupervisorObjectId` and passes it to
  # `makeToken()`.
  #
  # If any of the conditions listed in `requirements` become untrue, the returned token will be
  # disabled (cannot be restored).

  makeChildToken @5 (parent :Data, owner :ApiTokenOwner,
                     requirements :List(MembraneRequirement)) -> (token :Data);
  # Given a token (probably originally passed to `Supervisor.restore()`), create a new token
  # pointing to the same capability, where if the original token is revoked, the new token is
  # also transitively revoked.

  getOwnerNotificationTarget @2 () -> (owner :Grain.NotificationTarget);
  # Get the notification target to use for notifications relating to the grain itself, e.g.
  # presence of wake locks.

  checkRequirements @4 (requirements :List(MembraneRequirement))
                    -> (observer :RequirementObserver);
  # Verifies that all the requirements in the list are met, throwing an exception if one or more
  # are not met.

  interface RequirementObserver {
    observe @0 ();
    # Does not return as long as the requirements remains met. If at some point a requirement is
    # broken, throws an exception. When implementing a membrane based on this, after an exception
    # is thrown, the membrane should begin throwing the same exception from all methods called
    # through it.
    #
    # The caller may cancel this call via normal Cap'n Proto cancellation. (The callee must
    # implement cancellation correctly.)
    #
    # Note that the callee may choose to pessimistically throw a DISCONNECTED exception if the
    # requirements *might* have changed (but might not have). This will naturally force the
    # application to re-restore() all capabilities which will lead to a full requirement check
    # being performed. Thus, the implementation of RequirementObserver need not actually remember
    # the exact requirement list, but only enough information to detect when they _might_ have
    # been broken.
  }
}

struct MembraneRequirement {
  # Indicates some condition which, if it becomes untrue, will cause a membrane to be revoked.

  union {
    tokenValid @0 :Text;
    # This token is valid only as long as some *other* token is also still valid. `tokenValid`
    # specifies the `_id` of the other ApiToken.

    permissionsHeld :group {
      # This token is valid only as long as some specified identity holds some specified set of
      # permissions on some specified grain.

      identityId @5 :Text;
      # The identity that must hold the permissions.

      grainId @2 :Text;
      # The grain on which the permissions must be held.

      permissions @3 :Grain.PermissionSet;
      # The permissions the user must hold on the grain.

      userId @1 :Text;
      # Deprecated. See `identityId`.
    }

    userIsAdmin @4 :Text;
    # The capability is valid only as long as the given user is an administrator.
  }
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

  addRequirements @0 (requirements :List(MembraneRequirement)) -> (cap :SystemPersistent);
  # Returns a new version of this same capability with the given requirements added to the
  # conditions under which the capability may be revoked. Usually, the caller then calls `save()`
  # on the new capability.
}

interface PersistentHandle extends(SystemPersistent, Util.Handle) {}

interface PersistentOngoingNotification extends(SystemPersistent, Grain.OngoingNotification) {}

struct DenormalizedGrainMetadata {
  # The metadata that we need to present contextual information for shared grains (in particular,
  # information about the app providing that grain, like icon and title).

  appTitle @0 :Util.LocalizedText;
  # A copy of the app name for the corresponding UIView for presentation in the grain list.

  union {
    icon :group {
      format @1 :Text;
      # Icon asset format, if present.  One of "png" or "svg"

      assetId @2 :Text;
      # The asset ID associated with the grain-size icon for this token

      assetId2xDpi @3 :Text;
      # If present, the asset ID for the equivalent asset as assetId at twice-resolution
    }
    appId @4 :Text;
    # App ID, needed to generate a favicon if no icon is provided.
  }
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

      introducerIdentity @9 :Text;
      # Obsolete. See `clientPowerboxRequest.introducerIdentity`.

      introducerUser @5 :Text;
      # Obsolete. See `clientPowerboxRequest.introducerIdentity`.
    }

    clientPowerboxRequest :group {
      # Owned by a local grain, but only halfway through a client-side powerbox request flow.
      # The token will be automatically deleted after a short amount of time. Before then, the
      # grain must call `SandstormApi.claimRequest()` to get a proper sturdyref.

      grainId @13 :Text;
      # Grain ID owning the ref.

      introducerIdentity @14 :Text;
      # The identity ID through which a user's powerbox action caused the grain to receive this
      # token. This is the identity against which the `requiredPermissions` parameter
      # to `claimRequest()` will be checked.
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

    user :group {
      # Owned by a user's identity. If the token represents a UiView, then it will show up in this
      # user's grain list.

      identityId @10 :Text;
      # The identity that is allowed to restore this token.

      title @7 :Text;
      # Title as chosen by the user, or as copied from the sharer.

      # Fields below this line are not actually allowed to be passed to save(), but are added
      # internally.

      denormalizedGrainMetadata @8 :DenormalizedGrainMetadata;
      # Information needed to show the user an app title and icon in the grain list.

      userId @6 :Text;
      # Deprecated. See `identityId`.

      upstreamTitle @11 :Text;
      # Title as chosen by the grain owner. This field is directly updated whenever the grain owner
      # changes the title. As an optimization, this field is omitted if the value would be
      # identical to `title`.

      renamed @12 :Bool;
      # True if the user has explicitly renamed the grain to differ from the owner's title.
      # Otherwise, `title` is a copy of either the current or previous value of `upstreamTitle`.
    }
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
