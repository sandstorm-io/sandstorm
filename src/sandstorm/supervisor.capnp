# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
# All rights reserved.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
# 1. Redistributions of source code must retain the above copyright notice, this
#    list of conditions and the following disclaimer.
# 2. Redistributions in binary form must reproduce the above copyright notice,
#    this list of conditions and the following disclaimer in the documentation
#    and/or other materials provided with the distribution.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
# ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
# WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
# DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
# ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
# (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
# LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
# ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
# (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
# SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

@0xc7205d6d32c7b040;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Util = import "util.capnp";
using Grain = import "grain.capnp";

# //host/<grain-id>?action=open

# The way the coordinator works is:
# - UiViews are always persistable.  So restoring a grain means restoring a SturdyRef.  A grain ID
#   is just a SturdyRef for the main UiView.
# - Sessions are transient.
# - In a single-web-server environment, we can hold the session in the HTTP server.
# - So on a "load grain" request, we just restore the SturdyRef.

interface Application {
  getEntryPoints @0 () -> (entryPoints :List(EntryPoint));

  interface EntryPoint {
    run @0 (param :Grain.PowerboxCapability) -> (view :Grain.UiView);
  }
}

struct AppHash {
}

interface AppLoader {
  getApp @0 (hash :AppHash) -> GetAppResponse;
  struct GetAppResponse {
    union {
      notFound @0 :Void;
      found @1 :Application;
    }
  }

  # TODO(soon):  Load app from URL, file, raw data, etc.



  # TODO(someday):  Get EntryPoints matching PowerboxCapability.
}

interface ShellSession {
  # TODO(someday):  Implement a queue of SessionContext requests?  The shell polls for requests and
  #   then posts responses.  Or do we want to implement Cap'n Proto all the way back to the browser
  #   via WebSocket instead?  We wouldn't want a temporary network hiccup to kill the connection,
  #   though.
}
