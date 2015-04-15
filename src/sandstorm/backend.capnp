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
using GrainInfo = import "grain.capnp".GrainInfo;

interface Backend {
  # Interface that thet Sandstorm front-end uses to talk to the "back end", i.e. the container
  # scheduler. While Sandstorm is running, the backend interface is exported as a socket at
  # "/var/sandstorm/socket/backend".

  const socketPath :Text = "/var/sandstorm/socket/backend";

  startGrain @0 (ownerId :Text, grainId :Text, packageId :Text,
                 command :Package.Manifest.Command, isNew :Bool, devMode :Bool = false)
             -> (grain :Supervisor);
  # Start a grain.

  getGrain @1 (ownerId :Text, grainId :Text) -> (grain :Supervisor);
  # Get the grain if it's running, or throw a DISCONNECTED exception otherwise.

  deleteGrain @2 (ownerId :Text, grainId :Text);
  # Delete a grain from disk. Succeeds silently if the grain doesn't exist.

  installPackage @3 () -> (stream :PackageUploadStream);
  interface PackageUploadStream extends(Util.ByteStream) {
    saveAs @0 (packageId :Text) -> (appId :Text, manifest :Package.Manifest);
  }

  backupGrain @4 (ownerId :Text, grainId :Text, info :GrainInfo, stream :Util.ByteStream);
  # Makes a .zip of the contents of the given grain and writes the content to `stream`.

  restoreGrain @5 (ownerId :Text, grainId :Text) -> (stream :GrainUploadStream);
  # Upload a .zip created with backupGrain() and unpack it into a new grain.

  interface GrainUploadStream extends(Util.ByteStream) {
    getInfo @0 () -> (info :GrainInfo);
  }
}
