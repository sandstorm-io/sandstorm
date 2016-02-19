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
#include <kj/test.h>
#include <sandstorm/appid-replacements-test.capnp.h>
#include <set>

namespace sandstorm {
namespace {

kj::Array<kj::byte> appidBytes(kj::StringPtr id) {
  auto result = kj::heapArray<kj::byte>(APP_ID_BYTE_SIZE);
  KJ_REQUIRE(tryParseAppId(id, result), "invalid app ID", id);
  return result;
}

kj::Array<kj::byte> pkgidBytes(kj::StringPtr id) {
  auto result = kj::heapArray<kj::byte>(PACKAGE_ID_BYTE_SIZE);
  KJ_REQUIRE(tryParsePackageId(id, result), "invalid package ID", id);
  return result;
}

// =======================================================================================
// Check for errors in table

KJ_TEST("table: all IDs are valid") {
  for (auto replacement: *spk::APP_ID_REPLACEMENT_LIST) {
    {
      auto canonical = appIdString(appidBytes(replacement.getOriginal()));
      KJ_ASSERT(replacement.getOriginal() == canonical,
                "original app ID is not canonical", canonical, replacement);
    }
    {
      auto canonical = appIdString(appidBytes(replacement.getReplacement()));
      KJ_ASSERT(replacement.getReplacement() == canonical,
                "original app ID is not canonical", canonical, replacement);
    }

    for (auto pkgid: replacement.getRevokeExceptPackageIds()) {
      auto canonical = packageIdString(pkgidBytes(pkgid));
      KJ_ASSERT(pkgid == canonical,
                "package ID is not canonical", pkgid, canonical);
    }
  }
}

KJ_TEST("table: no duplicate originals") {
  std::set<kj::StringPtr> set;
  for (auto replacement: *spk::APP_ID_REPLACEMENT_LIST) {
    KJ_ASSERT(set.insert(replacement.getOriginal()).second,
              "duplicate original app ID", replacement);
  }
}

KJ_TEST("table: no duplicate replacements") {
  std::set<kj::StringPtr> set;
  for (auto replacement: *spk::APP_ID_REPLACEMENT_LIST) {
    KJ_ASSERT(set.insert(replacement.getReplacement()).second,
              "duplicate replacement app ID", replacement);
  }
}

KJ_TEST("table: no duplicate packages") {
  std::set<kj::StringPtr> set;
  for (auto replacement: *spk::APP_ID_REPLACEMENT_LIST) {
    for (auto pkgid: replacement.getRevokeExceptPackageIds()) {
      KJ_ASSERT(set.insert(pkgid).second, "duplicate package ID", pkgid);
    }
  }
}

// =======================================================================================
// Test table-handling logic

kj::String doReplacement(kj::StringPtr appId, kj::StringPtr packageId) {
  auto bytes = appidBytes(appId);
  applyAppidReplacements(bytes, pkgidBytes(packageId), *TEST_APP_ID_REPLACEMENT_LIST);
  return appIdString(bytes);
}

kj::String doGetPublicKey(kj::StringPtr appId) {
  return appIdString(getPublicKeyForApp(appidBytes(appId), *TEST_APP_ID_REPLACEMENT_LIST));
}

KJ_TEST("logic: unlisted (normal) app ID") {
  KJ_ASSERT(doReplacement(TestIds::UNUSED_APP, TestIds::UNUSED_PKG) == TestIds::UNUSED_APP);
}

KJ_TEST("logic: revoked app ID") {
  KJ_EXPECT_THROW(FAILED, doReplacement(TestIds::APP1, TestIds::UNUSED_PKG));
  KJ_EXPECT_THROW(FAILED, doReplacement(TestIds::APP5, TestIds::UNUSED_PKG));
}

KJ_TEST("logic: revoked app ID, whitelisted package") {
  KJ_ASSERT(doReplacement(TestIds::APP1, TestIds::PKG1) == TestIds::APP1);
  KJ_ASSERT(doReplacement(TestIds::APP1, TestIds::PKG2) == TestIds::APP1);
}

KJ_TEST("logic: replacement app ID, original revoked") {
  KJ_ASSERT(doReplacement(TestIds::APP2, TestIds::UNUSED_PKG) == TestIds::APP1);
}

KJ_TEST("logic: replacement app ID, original not revoked") {
  KJ_ASSERT(doReplacement(TestIds::APP5, TestIds::PKG3) == TestIds::APP4);
}

KJ_TEST("logic: app ID with replacement, but not revoked") {
  KJ_ASSERT(doReplacement(TestIds::APP4, TestIds::UNUSED_PKG) == TestIds::APP4);
}

KJ_TEST("logic: double-replacement app ID") {
  KJ_ASSERT(doReplacement(TestIds::APP3, TestIds::UNUSED_PKG) == TestIds::APP1);
}

KJ_TEST("logic: double-replacement app ID, replacement revoked") {
  KJ_ASSERT(doReplacement(TestIds::APP6, TestIds::UNUSED_PKG) == TestIds::APP4);
}

KJ_TEST("logic: get public key for app") {
  KJ_ASSERT(doGetPublicKey(TestIds::UNUSED_APP) == TestIds::UNUSED_APP);
  KJ_ASSERT(doGetPublicKey(TestIds::APP1) == TestIds::APP3);
  KJ_ASSERT(doGetPublicKey(TestIds::APP2) == TestIds::APP3);
  KJ_ASSERT(doGetPublicKey(TestIds::APP3) == TestIds::APP3);
  KJ_ASSERT(doGetPublicKey(TestIds::APP4) == TestIds::APP6);
  KJ_ASSERT(doGetPublicKey(TestIds::APP5) == TestIds::APP6);
  KJ_ASSERT(doGetPublicKey(TestIds::APP6) == TestIds::APP6);
}

}  // namespace
}  // namespace sandstorm
