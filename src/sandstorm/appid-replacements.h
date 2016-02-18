// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#ifndef SANDSTORM_APPID_REPLACEMENTS_H_
#define SANDSTORM_APPID_REPLACEMENTS_H_

#include <sandstorm/appid-replacements.capnp.h>

namespace sandstorm {

void applyAppidReplacements(
    kj::ArrayPtr<kj::byte> appId, kj::ArrayPtr<const kj::byte> packageId,
    capnp::List<spk::AppIdReplacement>::Reader replacements = *spk::APP_ID_REPLACEMENT_LIST);
// Given an input app ID that was just verified to have signed the given package ID,
// check appid-replacements.capnp to see if the app ID is revoked (throws exception) or the
// package should be treated as some other app (replaces appId).
//
// The third argument can be used to specify an alternate replacement list for testing purposes,
// but the intent is that production use should use the default list.

kj::Array<kj::byte> getPublicKeyForApp(kj::ArrayPtr<const kj::byte> appId,
    capnp::List<spk::AppIdReplacement>::Reader replacements = *spk::APP_ID_REPLACEMENT_LIST);
// Gets the public key associated with the given app ID. This is the reverse operation from
// applyAppidReplacements(): given a canonical app ID, it finds the key that is currently being
// used to sign new versions of the app.

} // namespace sandstorm

#endif // SANDSTORM_APPID_REPLACEMENTS_H_
