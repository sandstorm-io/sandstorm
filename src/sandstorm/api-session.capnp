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

@0xeb014c0c3413cbfb;

$import "/capnp/c++.capnp".namespace("sandstorm");

using WebSession = import "web-session.capnp";
using IpAddress = import "ip.capnp".IpAddress;

interface ApiSession @0xc879e379c625cdc7 extends(WebSession.WebSession) {
  # A special case of WebSession but for APIs. It doesn't provide much other
  # than a unique type id that we can identify ApiSessions with

  struct Params {
    # Normally, we strip the remote address from requests, since most applications shouldn't need
    # it.  However, for those that benefit from it (like analytics), clients can opt into passing
    # their IP on to the backend by adding an "X-Sandstorm-Pass-IP: yes" header to their request.
    # This would be a privacy leak for WebSession, since the grain can give the client scripts which
    # would send the header, but ApiSession requires a user action, so it's safe here.
    remoteAddress @0 :IpAddress;
  }
}
