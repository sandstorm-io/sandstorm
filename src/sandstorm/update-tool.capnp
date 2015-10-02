# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

@0x96c3fff3f4beb8fe;
# This file contains schemas relevant to the Sandstorm self-updater.

$import "/capnp/c++.capnp".namespace("sandstorm");

struct PublicSigningKey {
  key0 @0 :UInt64;
  key1 @1 :UInt64;
  key2 @2 :UInt64;
  key3 @3 :UInt64;
  # ed25519 public key.
}

struct Signature {
  sig0 @0 :UInt64;
  sig1 @1 :UInt64;
  sig2 @2 :UInt64;
  sig3 @3 :UInt64;
  sig4 @4 :UInt64;
  sig5 @5 :UInt64;
  sig6 @6 :UInt64;
  sig7 @7 :UInt64;
}

const updatePublicKeys :List(PublicSigningKey) = [
  # List of public keys with which Sandstorm updates are signed. The last key in this list should
  # be used to verify updates. When we "rotate" keys, we actually add a new key, but keep signing
  # with the old keys as well, so that existing servers can update.

  (key0 = 0x5a2d999e727ba977, key1 = 0x83cea6e0708ccf63, key2 = 0xdf70ccedc4be19bc, key3 = 0x81087ee2db417366),
];

struct UpdateSignature {
  # Format of a signature file.

  signatures @0 :List(Signature);
  # Signatures corresponding to each key in updatePublicKeys.
}
