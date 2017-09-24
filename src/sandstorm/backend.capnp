# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

@0xdcbc0d702b1b47a5;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Util = import "util.capnp";
using Package = import "package.capnp";
using Supervisor = import "supervisor.capnp".Supervisor;
using SandstormCore = import "supervisor.capnp".SandstormCore;
using GrainInfo = import "grain.capnp".GrainInfo;

using WebSession = import "web-session.capnp".WebSession;
using ApiSession = import "api-session.capnp".ApiSession;

interface Backend {
  # Interface that thet Sandstorm front-end uses to talk to the "back end", i.e. the container
  # scheduler. While Sandstorm is running, the backend interface is exported as a socket at
  # "/var/sandstorm/socket/backend".

  const socketPath :Text = "/var/sandstorm/socket/backend";
  # TODO(cleanup): When the experimental gateway is enabled, we also use a new approach to
  #   connecting components using socketpairs instead of paths on-disk, making this constant
  #   obsolete. Delete it once the gateway is enabled everywhere.

  ping @14 ();
  # Just returns. Used to verify that the connection to the back-end is alive and well.

  # ----------------------------------------------------------------------------

  startGrain @0 (ownerId :Text, grainId :Text, packageId :Text,
                 command :Package.Manifest.Command, isNew :Bool,
                 devMode :Bool = false, mountProc :Bool = false)
             -> (supervisor :Supervisor);
  # Start a grain.

  getGrain @1 (ownerId :Text, grainId :Text) -> (supervisor :Supervisor);
  # Get the grain if it's running, or throw a DISCONNECTED exception otherwise.

  deleteGrain @2 (ownerId :Text, grainId :Text);
  # Delete a grain from disk. Succeeds silently if the grain doesn't exist.

  transferGrain @12 (ownerId :Text, grainId :Text, newOwnerId :Text);
  # Transfer a grain's ownership.

  deleteUser @13 (userId :Text);
  # Delete an entire user. May or may not delete grains.

  # ----------------------------------------------------------------------------

  installPackage @3 () -> (stream :PackageUploadStream);
  interface PackageUploadStream extends(Util.ByteStream) {
    saveAs @0 (packageId :Text) -> (appId :Text, manifest :Package.Manifest,
                                    authorPgpKeyFingerprint :Text);
    # `authorPgpKeyFingerprint` is present only if the signature is valid, and is null if there
    # is no signature. (Invalid signature throws exception.)
  }

  tryGetPackage @4 (packageId :Text) -> (appId :Text, manifest :Package.Manifest,
                                         authorPgpKeyFingerprint :Text);
  # Get info from an already-installed package. Return values are null if the package doesn't
  # exist.

  deletePackage @5 (packageId :Text);
  # Delete a package from disk. Succeeds silently if the package doesn't exist.

  # ----------------------------------------------------------------------------
  # backups

  backupGrain @6 (backupId :Text, ownerId :Text, grainId :Text, info :GrainInfo);
  # Makes a .zip of the contents of the given grain and stores it as a backup file.

  restoreGrain @7 (backupId :Text, ownerId :Text, grainId :Text) -> (info :GrainInfo);
  # Unpack a stored backup into a new grain.

  uploadBackup @8 (backupId :Text) -> (stream :Util.ByteStream);
  # Upload a zip to create a new backup. If `stream.done()` does not get called and return
  # successfully, the backup wasn't saved.

  downloadBackup @9 (backupId :Text, stream :Util.ByteStream);
  # Download a stored backup, writing it to `stream`.

  deleteBackup @10 (backupId :Text);
  # Delete a stored backup from disk. Succeeds silently if the backup doesn't exist.

  # ----------------------------------------------------------------------------

  getUserStorageUsage @11 (userId :Text) -> (size :UInt64);
  # Returns the number of bytes of data in storage attributed to the given user.
  #
  # This method is not implemented by the single-machine version of Sandstorm, which does not track
  # per-user storage quotas.

  getGrainStorageUsage @15 (ownerId :Text, grainId :Text) -> (size :UInt64);
  # Returns the number of bytes of data in storage attributed to the given grain.
  #
  # On single-machine Sandstorm, this walks the directory tree, which may be slow. Therefore,
  # it is recommended that this not be called often.
}

interface GatewayRouter {
  # Interface which the gateway (C++ code which directly handles HTTP and other traffic) uses to
  # call into Sandstorm's business logic (Node.js process) in order to figure out how to route
  # things.
  #
  # (The Gateway actually conencts to the backend first, which gives it a GatewayRouter as the
  # bootstrap capability. The backend hooks that capability up to the shell, making sure to update
  # the routing any time the shell dies and restarts.)
  #
  # Note that the gateway also makes direct HTTP/WebSocket and SMTP connections for traffic that
  # it does not know how to handle directly.

  openUiSession @0 (sessionCookie :Text) -> (session :WebSession);
  # Given a sandstorm-sid cookie value for a UI session, find the WebSession to handle requests.
  #
  # The gateway may cache the session capability, associated with this cookie value, for as long
  # as it wants. However, session will become disconnected if the grain shuts down or if the user's
  # privileges are revoked. In that case, the gateway will need to discard the capability and
  # request a new one.

  openApiSession @1 (apiToken :Text) -> (session :ApiSession);
  # Given a token from an `Authorization` header, find the ApiSession to handle requests.
  #
  # The gateway may cache the session capability, associated with this token, for as long as it
  # wants. However,  session will become disconnected if the grain shuts down or if the user's
  # privileges are revoked. In that case, the gateway will need to discard the capability and
  # request a new one.
  #
  # Generally, traffic on an ApiSession will force the grain to stay running. This differs from UI
  # sessions, where the Sandstorm shell keeps track of which grains are open in tabs and decides
  # whether their servers need to keep running.

  getStaticAsset @2 (id :Text) -> (content :Data, type :Text, encoding :Text);
  # Look up the content of a static asset by ID. `type` and `encoding` are the values for the
  # `Content-Type` and `Content-Encoding` headers, respectively.

  getStaticPublishingHost @3 (publicId :Text) -> (supervisor :Supervisor);
  # Maps a grain's "public ID" to a grain supervisor, whose getWwwFileHack() method will be used
  # to host static files.

  routeForeignHostname @4 (hostname :Text) -> (info :ForeignHostnameInfo);
  # Called when the gateway receives a request for a hostname that doesn't match any of the
  # expected hostname patterns, to figure out what it is.

  struct ForeignHostnameInfo {
    union {
      unknown @0 :Void;
      # This is not a known host.

      staticPublishing @1 :Text;
      # It's a static publishing host. Value is the public ID.

      standalone @2 :Void;
      # It's a standalone host. HTTP requests should be routed directly to Node business logic.
    }

    ttlSeconds @3 :UInt32;
    # How long the receiver can safely cache this lookup result.
  }

  # TODO(someday): We could possibly eliminate the need for any HTTP traffic to Node by serving
  #   static assets directly from the gateway and by opening the DDP WebSocket over Cap'n Proto.
  #   However, this might not be a win until Cap'n Proto is implemented in native Javascript on the
  #   Node side.
}

interface SandstormCoreFactory {
  # Interface that the Sandstorm front-end exports to the backend in order to expose business
  # logic hooks.
  #
  # TODO(cleanup): Rename to something more appropriate, now that this does more than construct
  #   SansdtormCores.

  getSandstormCore @0 (grainId :Text) -> (core :SandstormCore);
  # Create a SandstormCore for a grain. Eventually, we'll move away from implementing SandstormCore
  # in the front-end and have it be implemented in the backend. This method will go away then.

  getGatewayRouter @1 () -> (router :GatewayRouter);
  # Gets an GatewayRouter implementation. Note that in Blackrock, where multiple instances of the
  # shell might be running, all GatewayRouters are equivalent, regardless of which shell replica
  # they came from.
}
