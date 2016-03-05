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

interface Backend {
  # Interface that thet Sandstorm front-end uses to talk to the "back end", i.e. the container
  # scheduler. While Sandstorm is running, the backend interface is exported as a socket at
  # "/var/sandstorm/socket/backend".

  const socketPath :Text = "/var/sandstorm/socket/backend";

  ping @14 ();
  # Just returns. Used to verify that the connection to the back-end is alive and well.

  # ----------------------------------------------------------------------------

  startGrain @0 (ownerId :Text, grainId :Text, packageId :Text,
                 command :Package.Manifest.Command, isNew :Bool, devMode :Bool = false)
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
}

interface SandstormCoreFactory {
  # Interface that the Sandstorm front-end exports to the backend for creating a SandstormCore
  # for a grain. Eventually, we'll move away from implementing SandstormCore in the front-end and
  # have it be implemented in the backend. This interface will go away then.
  getSandstormCore @0 (grainId :Text) -> (core :SandstormCore);
}
