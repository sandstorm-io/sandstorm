// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

#include "util.h"
#include <kj/test.h>

namespace sandstorm {
namespace {

KJ_TEST("base64 encoding/decoding") {
  {
    auto encoded = base64Encode(kj::StringPtr("foo").asBytes(), false);
    KJ_EXPECT(encoded == "Zm9v", encoded, encoded.size());
    KJ_EXPECT(kj::heapString(base64Decode(encoded).asChars()) == "foo");
  }

  {
    auto encoded = base64Encode(kj::StringPtr("corge").asBytes(), false);
    KJ_EXPECT(encoded == "Y29yZ2U=", encoded);
    KJ_EXPECT(kj::heapString(base64Decode(encoded).asChars()) == "corge");
  }

  KJ_EXPECT(kj::heapString(base64Decode("Y29yZ2U").asChars()) == "corge");
  KJ_EXPECT(kj::heapString(base64Decode("Y\n29y Z@2U=\n").asChars()) == "corge");

  {
    auto encoded = base64Encode(kj::StringPtr("corge").asBytes(), true);
    KJ_EXPECT(encoded == "Y29yZ2U=\n", encoded);
  }

  kj::StringPtr fullLine = "012345678901234567890123456789012345678901234567890123";
  {
    auto encoded = base64Encode(fullLine.asBytes(), false);
    KJ_EXPECT(
        encoded == "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIz",
        encoded);
  }
  {
    auto encoded = base64Encode(fullLine.asBytes(), true);
    KJ_EXPECT(
        encoded == "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIz\n",
        encoded);
  }

  kj::String multiLine = kj::str(fullLine, "456");
  {
    auto encoded = base64Encode(multiLine.asBytes(), false);
    KJ_EXPECT(
        encoded == "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2",
        encoded);
  }
  {
    auto encoded = base64Encode(multiLine.asBytes(), true);
    KJ_EXPECT(
        encoded == "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIz\n"
                   "NDU2\n",
        encoded);
  }
}

}  // namespace
}  // namespace sandstorm
