# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

@0xa53cae3f717a1676;
# This file is used to recover from lost or stolen app keys.
#
# If you are an app developer and you have lost access to your key or suspect it may have been
# compromised, add a line to this file and submit a pull request. Please either use git PGP
# signing to sign the request, or include with the request a PGP-signed copy of the diff. Use the
# same PGP key that you used to sign the app listing on the app market, if possible (if not, we
# will ask for other verification).

$import "/capnp/c++.capnp".namespace("sandstorm::spk");

struct AppIdReplacement {
  # Specifies that packages signed by the app ID specified in `replacement` shall henceforth be
  # treated as if they had instead be signed by `original`. Hence, packages signed with the
  # replacement key will be accepted as upgrades to the original and will be displayed as if
  # they had the original ID.

  original @0 :Text;
  # The original App ID, in text format for convenience. This is the canonical ID for this app,
  # and will remain so going forward.

  replacement @1 :Text;
  # The replacement App ID, in text format for convenience. Packages signed with this ID will be
  # treated as if they are signed with the original ID. Omit this to revoke an ID with no
  # replacement.
  #
  # Note: Do NOT distribute any packages signed with the new ID until a Sandstorm release has gone
  # out with your app ID replacement, otherwise people who install the app too early will be unable
  # to update it.

  revokeExceptPackageIds @2 :List(Text);
  # A list of package IDs (in text format for convenience) which were signed with the original
  # key and are known to be authentic versions of this app. All other packages signed with the
  # original key will be presumed malicious and rejected.
  #
  # Only specify this if the original key may have been compromised. If the key was merely lost
  # (e.g. storage was destroyed with no backup) then there is no need to revoke the old key.
  # In this case, omit this field (making it null).
}

const appIdReplacementList :List(AppIdReplacement) = [
  # ---- example entry ----

  (original = "vjvekechd398fn1t1kn1dgdnmaekqq9jkjv3zsgzymc4z913ref0",
   replacement = "wq95qmutckc0yfmecv0ky96cqxgp156up8sv81yxvmery58q87jh",
   revokeExceptPackageIds = ["b5bb9d8014a0f9b1d61e21e796d78dcc"]),
  # This is the ID for My Cool Example App by Kenton Varda. The old app key was compromised when
  # it was accidentally committed to the app's public git repo. Only one version ("b5bb...") had
  # ever been published.

  # ---- end exmaple; real entries follow ----

  # Add your entry here!
];
