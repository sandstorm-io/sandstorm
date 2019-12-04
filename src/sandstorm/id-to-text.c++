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
#include "util.h"
#include <kj/encoding.h>

namespace sandstorm {

namespace {

// =======================================================================================
// base32 encode/decode derived from google-authenticator code, Apache 2.0 license:
//   https://code.google.com/p/google-authenticator/source/browse/libpam/base32.c
//
// Modifications:
// - Prefer to output in lower-case letters.
// - Use Douglas Crockford's alphabet mapping, except instead of excluding 'u', consider 'B' to
//   be a misspelling of '8'.
// - Use a lookup table for decoding (in addition to encoding).  Generate this table
//   programmatically at compile time.  C++14 constexpr is awesome.
// - Convert to KJ style.

constexpr char BASE32_ENCODE_TABLE[] = "0123456789acdefghjkmnpqrstuvwxyz";

kj::String base32Encode(kj::ArrayPtr<const byte> data) {
  // We'll need a character for every 5 bits, rounded up.
  auto result = kj::heapString((data.size() * 8 + 4) / 5);

  uint count = 0;
  if (data.size() > 0) {
    uint buffer = data[0];
    uint next = 1;
    uint bitsLeft = 8;
    while (bitsLeft > 0 || next < data.size()) {
      if (bitsLeft < 5) {
        if (next < data.size()) {
          buffer <<= 8;
          buffer |= data[next++] & 0xFF;
          bitsLeft += 8;
        } else {
          // No more input; pad with zeros.
          uint pad = 5 - bitsLeft;
          buffer <<= pad;
          bitsLeft += pad;
        }
      }
      uint index = 0x1F & (buffer >> (bitsLeft - 5));
      bitsLeft -= 5;
      KJ_ASSERT(count < result.size());
      result[count++] = BASE32_ENCODE_TABLE[index];
    }
  }

  return result;
}

class Base32Decoder {
public:
  constexpr Base32Decoder(): decodeTable() {
    // Cool, we can generate our lookup table at compile time.

    for (byte& b: decodeTable) {
      b = 255;
    }

    for (uint i = 0; i < sizeof(BASE32_ENCODE_TABLE) - 1; i++) {
      unsigned char c = BASE32_ENCODE_TABLE[i];
      decodeTable[c] = i;
      if ('a' <= c && c <= 'z') {
        decodeTable[c - 'a' + 'A'] = i;
      }
    }

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wchar-subscripts"
    decodeTable['o'] = decodeTable['O'] = 0;
    decodeTable['i'] = decodeTable['I'] = 1;
    decodeTable['l'] = decodeTable['L'] = 1;
    decodeTable['b'] = decodeTable['B'] = 8;
#pragma GCC diagnostic pop
  }

  constexpr bool verifyTable() const {
    // Verify that all letters and digits have a decoding.
    //
    // Oh cool, this can also be done at compile time, and then checked with a static_assert below.
    //
    // C++14 is awesome.

    for (unsigned char c = '0'; c <= '9'; c++) {
      if (decodeTable[c] == 255) return false;
    }
    for (unsigned char c = 'a'; c <= 'z'; c++) {
      if (decodeTable[c] == 255) return false;
    }
    for (unsigned char c = 'A'; c <= 'Z'; c++) {
      if (decodeTable[c] == 255) return false;
    }
    return true;
  }

  bool tryDecode(kj::StringPtr encoded, kj::ArrayPtr<byte> output) const {
    // We intentionally round the size down.  Leftover bits are presumably zero.
    size_t expectedBytes = encoded.size() * 5 / 8;
    if (output.size() != expectedBytes) return false;

    uint buffer = 0;
    uint bitsLeft = 0;
    uint count = 0;
    for (char c: encoded) {
      byte decoded = decodeTable[(byte)c];
      if (decoded > 32) return false;

      buffer <<= 5;
      buffer |= decoded;
      bitsLeft += 5;
      if (bitsLeft >= 8) {
        KJ_ASSERT(count < output.size());
        bitsLeft -= 8;
        output[count++] = buffer >> bitsLeft;
      }
    }
    KJ_ASSERT(count == output.size());

    buffer &= (1 << bitsLeft) - 1;
    if (buffer != 0) return false;  // non-zero leftover bits!

    return true;
  }

private:
  byte decodeTable[256];
};

constexpr Base32Decoder BASE32_DECODER;
static_assert(BASE32_DECODER.verifyTable(), "Base32 decode table is incomplete.");

// =======================================================================================

static kj::Maybe<uint> parseHexDigit(char c) {
  if ('0' <= c && c <= '9') {
    return static_cast<uint>(c - '0');
  } else if ('a' <= c && c <= 'f') {
    return static_cast<uint>(c - 'a') + 0xa;
  } else if ('A' <= c && c <= 'F') {
    return static_cast<uint>(c - 'A') + 0xa;
  } else {
    return nullptr;
  }
}

}  // namespace

kj::String appIdString(spk::AppId::Reader appId) {
  return appIdString(capnp::AnyStruct::Reader(appId).getDataSection());
}

kj::String appIdString(kj::ArrayPtr<const kj::byte> appId) {
  KJ_REQUIRE(appId.size() == APP_ID_BYTE_SIZE);
  return base32Encode(appId);
}

bool tryParseAppId(kj::StringPtr in, spk::AppId::Builder out) {
  return tryParseAppId(in, capnp::AnyStruct::Builder(kj::mv(out)).getDataSection());
}

bool tryParseAppId(kj::StringPtr in, kj::ArrayPtr<kj::byte> out) {
  KJ_REQUIRE(out.size() == APP_ID_BYTE_SIZE);
  return BASE32_DECODER.tryDecode(in, out);
}

kj::String packageIdString(spk::PackageId::Reader packageId) {
  return packageIdString(capnp::AnyStruct::Reader(packageId).getDataSection());
}

kj::String packageIdString(kj::ArrayPtr<const kj::byte> packageId) {
  KJ_ASSERT(packageId.size() == PACKAGE_ID_BYTE_SIZE);
  return kj::encodeHex(packageId);
}

bool tryParsePackageId(kj::StringPtr in, spk::PackageId::Builder out) {
  return tryParsePackageId(in, capnp::AnyStruct::Builder(kj::mv(out)).getDataSection());
}

bool tryParsePackageId(kj::StringPtr in, kj::ArrayPtr<kj::byte> out) {
  if (in.size() != PACKAGE_ID_TEXT_SIZE) return false;

  KJ_ASSERT(out.size() == PACKAGE_ID_BYTE_SIZE);

  for (auto i: kj::indices(out)) {
    byte b = 0;
    KJ_IF_MAYBE(d, parseHexDigit(in[i*2])) {
      b = *d << 4;
    } else {
      return false;
    }
    KJ_IF_MAYBE(d, parseHexDigit(in[i*2+1])) {
      b |= *d;
    } else {
      return false;
    }
    out[i] = b;
  }

  return true;
}

} // namespace sandstorm

