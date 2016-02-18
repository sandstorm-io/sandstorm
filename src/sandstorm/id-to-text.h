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

#ifndef SANDSTORM_ID_TO_TEXT_H_
#define SANDSTORM_ID_TO_TEXT_H_

#include <kj/common.h>
#include <sandstorm/package.capnp.h>
#include <capnp/compat/json.h>
#include <kj/debug.h>

namespace sandstorm {

static const size_t APP_ID_BYTE_SIZE = 32;
static const size_t PACKAGE_ID_BYTE_SIZE = 16;
static const size_t APP_ID_TEXT_SIZE = 52;
static const size_t PACKAGE_ID_TEXT_SIZE = 32;

kj::String appIdString(spk::AppId::Reader appId);
kj::String appIdString(kj::ArrayPtr<const kj::byte> appId);
bool tryParseAppId(kj::StringPtr in, spk::AppId::Builder out);
bool tryParseAppId(kj::StringPtr in, kj::ArrayPtr<kj::byte> out);

kj::String packageIdString(spk::PackageId::Reader packageId);
kj::String packageIdString(kj::ArrayPtr<const kj::byte> packageId);
bool tryParsePackageId(kj::StringPtr in, spk::PackageId::Builder out);
bool tryParsePackageId(kj::StringPtr in, kj::ArrayPtr<kj::byte> out);

// =======================================================================================
// JSON handlers for AppId and PackageId, converting them to their standard textual form.
//
// Declared inline to avoid a dependency on JSON library if unused.

class AppIdJsonHandler: public capnp::JsonCodec::Handler<spk::AppId> {
public:
  void encode(const capnp::JsonCodec& codec, spk::AppId::Reader input,
              capnp::JsonValue::Builder output) const override {
    output.setString(appIdString(input));
  }

  void decode(const capnp::JsonCodec& codec, capnp::JsonValue::Reader input,
              spk::AppId::Builder output) const override {
    KJ_REQUIRE(input.isString() && tryParseAppId(input.getString(), output),
               "invalid app ID");
  }
};

class PackageIdJsonHandler: public capnp::JsonCodec::Handler<spk::PackageId> {
public:
  void encode(const capnp::JsonCodec& codec, spk::PackageId::Reader input,
              capnp::JsonValue::Builder output) const override {
    output.setString(packageIdString(input));
  }

  void decode(const capnp::JsonCodec& codec, capnp::JsonValue::Reader input,
              spk::PackageId::Builder output) const override {
    KJ_REQUIRE(input.isString() && tryParsePackageId(input.getString(), output),
               "invalid package ID");
  }
};

} // namespace sandstorm

#endif // SANDSTORM_ID_TO_TEXT_H_
