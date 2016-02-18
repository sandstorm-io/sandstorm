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

@0xbee445adfb01a777;

$import "/capnp/c++.capnp".namespace("sandstorm");
using AppIdReplacement = import "appid-replacements.capnp".AppIdReplacement;

struct TestIds {  # namespace only
  const unusedApp :Text = "6pm4ujs8f5f5wugc87uhuhvhs57he09u10rv8qd2jgdup9f69yzh";

  const app1 :Text = "vjvekechd398fn1t1kn1dgdnmaekqq9jkjv3zsgzymc4z913ref0";
  const app2 :Text = "wq95qmutckc0yfmecv0ky96cqxgp156up8sv81yxvmery58q87jh";
  const app3 :Text = "302t6c6kf8hjer1kh3469d4ch10d936g7wkwtxcs12pwh9u5axqh";
  const app4 :Text = "5ddk4uqnstnsqvp3thc2tyed41c7wp4x5ygt20zrh3u0tnv5jqd0";
  const app5 :Text = "jkz6yhywhp4uk5sgkc5ugwnee57a5h5wu4rfmujtahny5r8g3ych";
  const app6 :Text = "adk6syfj42fpp3xhgqrrheqgfxkhaw8e1t11vug44ys6pzaxqugh";

  const unusedPkg :Text = "7300e3448dd2b53e075d0a8481c2bc06";

  const pkg1 :Text = "b5bb9d8014a0f9b1d61e21e796d78dcc";
  const pkg2 :Text = "8613a11b8ac365cb36775a6b8ca6176c";
  const pkg3 :Text = "77c4f45aee83e376d31a5680cdb841a2";
}

const testAppIdReplacementList :List(AppIdReplacement) = [
  (original = TestIds.app1, replacement = TestIds.app2,
   revokeExceptPackageIds = [TestIds.pkg1, TestIds.pkg2]),

  (original = TestIds.app2, replacement = TestIds.app3),

  (original = TestIds.app4, replacement = TestIds.app5),

  (original = TestIds.app5, replacement = TestIds.app6,
   revokeExceptPackageIds = [TestIds.pkg3]),
];
