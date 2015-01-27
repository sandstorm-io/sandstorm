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

@0xb9f60cdd55ac0b19;
# This file contains interfaces used strictly between components of Sandstorm, NOT by Sandstorm
# applications.

$import "/capnp/c++.capnp".namespace("sandstorm");

using Persistent = import "/capnp/persistent.capnp".Persistent;
using Grain = import "grain.capnp";

struct InternalSturdyRef {
  # The representation of SturdyRefs used by Sandstorm components.
  #
  # This differs from `SturdyRef` defined in `grain.capnp` in that that type is the format for
  # refs as seen inside apps. The Sandstorm supervisor performs translation on refs as they pass
  # into and out of apps, in order to implement Distributed Confinement:
  #     http://www.erights.org/elib/capability/dist-confine.html
  #
  # The supervisor actually maintains a table of refs that have passed over the boundary.

  struct Owner {
    union {
      grain @0 :Text;
      # A grain. The text is its public ID.

      external @1 :AnyPointer;
      # An external owner (on the public internet).
      #
      # TODO(someday): Change AnyPointer to the type for public internet owners.
    }
  }

  union {
    apiToken @0 :Text;
    # Just a regular API token; see the ApiTokens table defined in db.js in the Sandstorm shell
    # code.

    external @1 :Text;
    # A capability hosted out on the internet. The value is the _id in the ExternalRefs table
    # stored by the front-end.
  }
}
