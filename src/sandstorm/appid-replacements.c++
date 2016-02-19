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

#include "appid-replacements.h"
#include "id-to-text.h"

namespace sandstorm {

void applyAppidReplacements(
    kj::ArrayPtr<kj::byte> appId, kj::ArrayPtr<const kj::byte> packageId,
    capnp::List<spk::AppIdReplacement>::Reader replacements) {
  // Given an input app ID that was just verified to have signed the given package ID,
  // check appid-replacements.capnp to see if the app ID is revoked (throws exception) or the
  // package should be treated as some other app (replaces appId).

  // The logic here is slightly weird because the replacement list is organized into events --
  // which makes it easier for people modifying it to understand what to do -- rather than into
  // rules -- which could be more directly processed. Each event introduces one or two rules:
  // a revocation of an original key (except for grandfathered whitelist) and a mapping of a
  // replacement key to and original key.

  KJ_REQUIRE(appId.size() == APP_ID_BYTE_SIZE);
  KJ_REQUIRE(packageId.size() == PACKAGE_ID_BYTE_SIZE);

  auto appidStr = appIdString(appId);
  auto pkgidStr = packageIdString(packageId);

  // First check if this app ID is revoked.
  for (auto item: replacements) {
    if (item.getOriginal() == appidStr) {
      // The app ID matches the `original` of this entry. Check if it was revoked.
      if (item.hasRevokeExceptPackageIds()) {
        // This app ID is revoked, except for specific package IDs...
        for (auto allowed: item.getRevokeExceptPackageIds()) {
          if (pkgidStr == allowed) {
            goto checkReplacements;  // Need to break outer loop...
          }
        }
        KJ_FAIL_REQUIRE("package is signed with an app key that has been revoked",
                        appidStr, pkgidStr);
      }
    }
  }

checkReplacements:
  // Not revoked. Now check if it is a replacement.
  for (auto item: replacements) {
    if (item.getReplacement() == appidStr) {
      // The app ID is a replacement. We want to make this package look like it uses the original
      // ID, therefore we want to replace the replacement with the original.
      KJ_ASSERT(tryParseAppId(item.getOriginal(), appId));

      // We may have mapped the replacement ID back to an ID which has itself been replaced.
      // So, we need to apply the replacements step again. We could make the rule that a second
      // replacement for the same app should list the app's original-original ID as `original`, but
      // this would mean that if the first replacement key needs to be revoked then two entries
      // would need to be made, which is not intuitive.
      appidStr = appIdString(appId);
      goto checkReplacements;
    }
  }
}

kj::Array<kj::byte> getPublicKeyForApp(kj::ArrayPtr<const kj::byte> appId,
    capnp::List<spk::AppIdReplacement>::Reader replacements) {
  KJ_REQUIRE(appId.size() == APP_ID_BYTE_SIZE);
  auto appidOwnStr = appIdString(appId);
  kj::StringPtr appidStr = appidOwnStr;
  auto result = kj::heapArray(appId);

retry:
  for (auto item: replacements) {
    if (item.getOriginal() == appidStr) {
      appidStr = item.getReplacement();
      KJ_ASSERT(tryParseAppId(appidStr, result));
      goto retry;
    }
  }

  return result;
}

}  // namespace sandstorm
