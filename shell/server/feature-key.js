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

import Bignum from "bignum";
import ed25519 from "ed25519";
const Capnp = Npm.require("capnp");
const FeatureKey = Capnp.importSystem("sandstorm/feature-key.capnp").FeatureKey;

// We don't currently have a way of reading the raw bytes of a capnp struct in Javascript the
// way we do in C++. Awkwardly, what we end up with is four 64-bit ints that have been stringified
// since JS can't actually deal with 64-bit ints. We have to laboriously reconstruct the underlying
// bytes using Bignum. Don't forget that everything is little-endian, as DJBeesus intended.
const bits0 = Bignum(FeatureKey.signingKey.key0);
const bits1 = Bignum(FeatureKey.signingKey.key1);
const bits2 = Bignum(FeatureKey.signingKey.key2);
const bits3 = Bignum(FeatureKey.signingKey.key3);
const signingKey = bits0
    .add(bits1.shiftLeft(64 * 1))
    .add(bits2.shiftLeft(64 * 2))
    .add(bits3.shiftLeft(64 * 3))
    .toBuffer({ endian: "little", size: 32 });

const isTesting = Meteor.settings && Meteor.settings.public &&
                  Meteor.settings.public.isTesting;

function verifyFeatureKeySignature(buf) {
  // buf is a Buffer containing an feature key with attached signature.
  // This function returns the signed data if the signature is valid,
  // or undefined if the signature is invalid.

  // Per crypto_sign, the first 64 bytes are the ed25519 signature
  // and the rest of the blob is the signed data.
  const signature = buf.slice(0, 64);
  const signedData = buf.slice(64);

  if (!ed25519.Verify(signedData, signature, signingKey)) {
    console.error("feature key failed signature check", bits0, bits1, bits2, bits3);
    return undefined;
  } else {
    return signedData;
  }
};

// Export for use in db.js and server/admin.js
loadSignedFeatureKey = function (buf) {
  // Given a Buffer containing a signed feature key, verifies and parses the feature key.
  // Returns the parsed FeatureKey if it was signed by a trusted key, or
  // undefined if the signature did not pass verification.
  const verifiedFeatureKeyBlob = verifyFeatureKeySignature(buf);
  if (verifiedFeatureKeyBlob) {
    const featureKey = Capnp.parsePacked(FeatureKey, verifiedFeatureKeyBlob);
    if (featureKey.isForTesting && !isTesting) {
      // This key is for testing only, but the server is not running in testing mode. Note that
      // enabling testing mode forfeits up all security.
      return undefined;
    }

    return featureKey;
  } else {
    return undefined;
  }
};
