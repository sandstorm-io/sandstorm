# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2020 Sandstorm Development Group, Inc. and contributors
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

@0xd4c5feffbd79e908;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Util = import "util.capnp";

interface Controller {
  # Bootstrap interface offered by sandstorm on the control socket.
  # This is used by some commands to control a running sandstorm
  # server.
  #
  # This interface is not currently implemented. For now the commands
  # referenced below use the `devmode` socket, and speak an ad-hoc
  # protocol that provides similar functionality.
  #
  # The old protocol exists for historical reasons: when the devmode
  # socket was first implemented, capnproto did not support passing
  # file descriptors with a message. Now it does, so there is no
  # need for a custom solution, and moving to capnproto will improve
  # extensibility and maintainability.

  const socketPath :Text = "/var/sandstorm/socket/control";
  # Path to the control socket, relative to the sandstorm install (normaly
  # /opt/sandstorm).

  devShell @0 () -> (shellFds :List(FileDescriptor), cancel :Util.Handle);
  # Stop the running sandstorm shell process, and get a list of file
  # descriptors that the shell should inherit on startup.
  #
  # This is used by `sandstorm dev-shell`; the returned file descriptors
  # will be passed to an instance of the shell launched from the developer's
  # source tree, rather than from the installed sandstorm root.
  #
  # - `shellFds` is a list of file descriptors that the shell should inherit.
  # - When `cancel` is dropped, the dev shell will be disconnected and
  #   Sandstorm will restart the normal shell process.

  dev @1 (appId :Text) -> (fuseFd :FileDescriptor, session :DevSession);
  # Start a dev session for the given app id. Used by `spk dev`.
  #
  # In the return value:
  #
  # - `fuseFd` is a file descriptor that `spk dev` should use to serve
  #   a fuse filesystem supplying the contents of the app package.
  # - `session` is used to control the active dev session. Drop the session
  #   to deactivate dev mode for the app.
}

interface DevSession {
  # A dev session for a particular app.

  updateManifest @0 ();
  # Tell the dev session to update its copy of the manifest. It will do this
  # by reading it from the fuse filesystem provided by `spk dev`.
}

interface FileDescriptor {
  # Dummy interface used to attach file descriptors to messages.
}
