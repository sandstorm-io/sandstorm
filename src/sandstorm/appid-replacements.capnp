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
# compromised, do the following:
# 1. Generate a new key using `vagrant-spk keygen`. The new key ID will be printed.
# 2. Use `vagrant-spk getkey <key-id> > backup.key` to make a backup copy of the key. Put
#    `backup.key` somewhere safe! Of course, do NOT make this file public!
# 3. Add an entry to `appIdReplacementList` below with `original` being your old key ID (app ID)
#    and `replacement` being the new key ID (as printed when you generated it).
# 4. PGP-sign your git commit using the `-S` flag, using the same PGP key you used to sign older
#    versions of your app as published to the app market. (If you can't do this, we'll need to
#    verify your identity in some other way.)
# 5. Submit a pull request.
#
# Things you should NOT do:
# * Do NOT change sandstorm-pkgdef.capnp to the new key. Once Sandstorm is updated with your PR,
#   the spk tool will automatically use the new key where appropriate.
# * Do NOT update your `pgpSignature` file. The signature should still assert ownership of the
#   original app ID.
# * Do NOT update links to the app market or anywhere else that incorporate the app ID. Your app ID
#   is not changing; only the signing key is changing.

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

  # ---- end example; real entries follow ----

  # ---- Paperwork entry ----

  (original = "vxe8awcxvtj6yu0vgjpm1tsaeu7x8v8tfp71tyvnm6ykkephu9q0",
   replacement = "n8cn71407n4mezn7mg0k5kkm21juuphhecc24hdf9kf56zyxm4ah"),
  # This is the ID for the Paperwork app by JJ. The old app key was destroyed

  # ---- end Paperwork entry ----

  # ---- draw.io entry ----

  (original = "nfqhx83vvzm80edpgkpax8mhqp176qj2vwg67rgq5e3kjc5r4cyh",
   replacement = "a3w50h1435gsxczugm16q0amwkqm9f4crykzea53sv61pt7phk8h",
   revokeExceptPackageIds = ["1450e0caa29b59ec938b3795bf17cb02", "738f0e56a9ca462e77245e3f392686d7"]),
  # This is the ID for the draw.io app by David Benson. The old app key was compromised when it was
  # accidentally published briefly in an upload to the Sandstorm app market. The upload was rejected
  # from the app market. Two versions had been published to the Sandstorm App Market ("1450..." and
  # "738f...").

  # ---- end draw.io entry ----

  # Add your entry here!
];
