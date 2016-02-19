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

#include "id-to-text.h"
#include <kj/test.h>
#include <capnp/message.h>
#include <sodium/randombytes.h>

namespace sandstorm {
namespace {

KJ_TEST("App IDs to text") {
  capnp::MallocMessageBuilder builder;
  auto id = builder.initRoot<spk::AppId>();
  auto bytes = capnp::AnyStruct::Builder(kj::cp(id)).getDataSection();
  auto orphan = builder.getOrphanage().newOrphan<spk::AppId>();
  auto outId = orphan.get();
  auto outBytes = capnp::AnyStruct::Builder(kj::cp(outId)).getDataSection();

  for (uint i = 0; i < 16; i++) {
    randombytes_buf(bytes.begin(), bytes.size());
    KJ_ASSERT(tryParseAppId(appIdString(id), outId));
    KJ_ASSERT(outBytes == bytes);
  }

  KJ_ASSERT(tryParseAppId("vjvekechd398fn1t1kn1dgdnmaekqq9jkjv3zsgzymc4z913ref0", outId));
  KJ_ASSERT(appIdString(outId) == "vjvekechd398fn1t1kn1dgdnmaekqq9jkjv3zsgzymc4z913ref0");

  KJ_ASSERT(tryParseAppId("wq95qmutckc0yfmecv0ky96cqxgp156up8sv81yxvmery58q87jh", outId));
  KJ_ASSERT(appIdString(outId) == "wq95qmutckc0yfmecv0ky96cqxgp156up8sv81yxvmery58q87jh");

  // Upper-case is equivalent to lower-case, and O -> 0, I -> 1, l -> 1, B -> 8.
  KJ_ASSERT(tryParseAppId("WQ95QMUTCKCOYFMECV0KY96CQXGPi56UP8SV8LYXVMERY5bQB7JH", outId));
  KJ_ASSERT(appIdString(outId) == "wq95qmutckc0yfmecv0ky96cqxgp156up8sv81yxvmery58q87jh");

  // Error cases:

  // too short
  KJ_ASSERT(!tryParseAppId("wq95qmutckc0yfmecv0ky96cqxgp156up8sv81yxvmery58q87j", outId));

  // too long
  KJ_ASSERT(!tryParseAppId("wq95qmutckc0yfmecv0ky96cqxgp156up8sv81yxvmery58q87jhh", outId));

  // not too long, but trailing nonzero bits
  KJ_ASSERT(!tryParseAppId("wq95qmutckc0yfmecv0ky96cqxgp156up8sv81yxvmery58q87jz", outId));

  // not base32
  KJ_ASSERT(!tryParseAppId("wq95qmutckc0yfmecv0ky96cq!gp156up8sv81yxvmery58q87jh", outId));
}

KJ_TEST("Package IDs to text") {
  capnp::MallocMessageBuilder builder;
  auto id = builder.initRoot<spk::PackageId>();
  auto bytes = capnp::AnyStruct::Builder(kj::cp(id)).getDataSection();
  auto orphan = builder.getOrphanage().newOrphan<spk::PackageId>();
  auto outId = orphan.get();
  auto outBytes = capnp::AnyStruct::Builder(kj::cp(outId)).getDataSection();

  for (uint i = 0; i < 16; i++) {
    randombytes_buf(bytes.begin(), bytes.size());
    KJ_ASSERT(tryParsePackageId(packageIdString(id), outId));
    KJ_ASSERT(outBytes == bytes);
  }

  KJ_ASSERT(tryParsePackageId("b5bb9d8014a0f9b1d61e21e796d78dcc", outId));
  KJ_ASSERT(packageIdString(outId) == "b5bb9d8014a0f9b1d61e21e796d78dcc");

  KJ_ASSERT(tryParsePackageId("7d865e959b2466918c9863afca942d0f", outId));
  KJ_ASSERT(packageIdString(outId) == "7d865e959b2466918c9863afca942d0f");

  // Upper-case is equivalent to lower-case.
  KJ_ASSERT(tryParsePackageId("7D865E959B2466918C9863AFCA942D0F", outId));
  KJ_ASSERT(packageIdString(outId) == "7d865e959b2466918c9863afca942d0f");

  // Error cases:

  KJ_ASSERT(!tryParsePackageId("7d865e959b2466918c9863afca942d0", outId));  // too short
  KJ_ASSERT(!tryParsePackageId("7d865e959b2466918c9863afca942d0ff", outId));  // too long
  KJ_ASSERT(!tryParsePackageId("00000000000nothex000000000000000", outId));
}

}  // namespace
}  // namespace sandstorm
