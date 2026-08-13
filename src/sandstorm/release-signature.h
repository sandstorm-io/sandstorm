// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm Contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#ifndef SANDSTORM_RELEASE_SIGNATURE_H_
#define SANDSTORM_RELEASE_SIGNATURE_H_

#include <kj/string.h>

namespace sandstorm {

constexpr size_t MAX_RELEASE_SIGNATURE_SIZE = 1024 * 1024;

bool hasValidReleaseSignature(
    kj::ArrayPtr<const char> gpgStatus, kj::StringPtr expectedPrimaryFingerprint);
// Parses GnuPG's machine-readable status output and returns true if at least one signature has both
// GOODSIG and VALIDSIG records whose OpenPGP primary-key fingerprint is
// expectedPrimaryFingerprint, using SHA-512 over a binary document. Expired, revoked, and bad
// signatures are rejected. Additional signatures made by unknown keys are ignored; this is what
// permits one detached-signature file to be signed by both sides of a key rotation.

void verifyReleaseSignature(
    int signatureFd, int bundleFd, kj::StringPtr gpgPath, kj::StringPtr keyringPath,
    kj::StringPtr expectedPrimaryFingerprint, kj::StringPtr libraryPath = nullptr);
// Verifies a detached OpenPGP signature using an explicitly-selected GnuPG binary and keyring.
// Throws unless the status output contains a good, valid signature from expectedPrimaryFingerprint.

}  // namespace sandstorm

#endif  // SANDSTORM_RELEASE_SIGNATURE_H_
