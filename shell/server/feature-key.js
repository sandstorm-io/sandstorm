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

const Capnp = Npm.require("capnp");
const FeatureKey = Capnp.importSystem("sandstorm/feature-key.capnp").FeatureKey;

// These byte-packing tricks that are so convenient in non-memory-safe languages are a
// bit of a pain in memory-safe languages.  Argh.  At least I have bignums on the server.
const bits0 = Bignum(FeatureKey.signingKey.key0);
const bits1 = Bignum(FeatureKey.signingKey.key1);
const bits2 = Bignum(FeatureKey.signingKey.key2);
const bits3 = Bignum(FeatureKey.signingKey.key3);
const signingKey = bits0.shiftLeft(64 * 3)
    .add(bits1.shiftLeft(64 * 2))
    .add(bits2.shiftLeft(64))
    .add(bits3)
    .toBuffer();

const verifyFeatureKeySignature = function (buf) {
  // buf is a Buffer containing an feature key with attached signature.
  // This function returns the signed data if the signature is valid,
  // or undefined if the signature is invalid.

  // Per crypto_sign, the first 64 bytes are the ed25519 signature
  // and the rest of the blob is the signed data.
  const signature = buf.slice(0, 64);
  const signedData = buf.slice(64);

  if (!Ed25519.Verify(signedData, signature, signingKey)) {
    return undefined;
  } else {
    return signedData;
  }
};

Meteor.methods({
  submitFeatureKey: function (textBlock) {
    check(textBlock, String);

    // Only allow admins to submit feature keys.
    if (!this.userId) throw new Meteor.Error(401, "Not logged in");
    const db = this.connection.sandstormDb;
    if (!db.isAdminById(this.userId)) throw new Meteor.Error(401, "Only admins may upload feature keys");

    // textBlock is a base64'd string, possibly with newlines and comment lines starting with "-"
    const featureKeyBase64 = _.chain(textBlock.split("\n"))
        .filter(line => (line.length > 0 && line[0] !== "-"))
        .value()
        .join("");

    const buf = new Buffer(featureKeyBase64, "base64");
    if (buf.length < 64) {
      throw new Meteor.Error(401, "Invalid feature key");
    }

    const verifiedFeatureKeyBlob = verifyFeatureKeySignature(buf);
    if (!verifiedFeatureKeyBlob) {
      throw new Meteor.Error(401, "Invalid feature key");
    }

    // Persist the feature key in the database.
    db.collections.featureKey.upsert(
      "currentFeatureKey",
      {
        _id: "currentFeatureKey",
        value: buf,
      }
    );
  },
});

const FIELDS_PUBLISHED_TO_ADMINS = [
  "customer", "expires", "features", "isElasticBilling", "isTrial", "issued", "userLimit",
];

Meteor.publish("featureKey", function () {
  if (!this.userId) return [];

  const db = this.connection.sandstormDb;
  if (!db.isAdminById(this.userId)) return [];

  const featureKeyQuery = db.collections.featureKey.find({ _id: "currentFeatureKey" });
  const observeHandle = featureKeyQuery.observe({
    added: (doc) => {
      // Load and verify the signed feature key.
      const buf = new Buffer(doc.value);
      const verifiedFeatureKeyBlob = verifyFeatureKeySignature(buf);

      if (verifiedFeatureKeyBlob) {
        // If the signature is valid, publish the feature key information.
        const featureKey = Capnp.parsePacked(FeatureKey, verifiedFeatureKeyBlob);
        const filteredFeatureKey = _.pick(featureKey, ...FIELDS_PUBLISHED_TO_ADMINS);
        this.added("featureKey", doc._id, filteredFeatureKey);
      }
    },

    changed: (newDoc, oldDoc) => {
      // Load and reverify the new signed feature key.
      const buf = new Buffer(newDoc.value);
      const verifiedFeatureKeyBlob = verifyFeatureKeySignature(buf);

      if (verifiedFeatureKeyBlob) {
        // If the signature is valid, call this.changed() with the interesting fields.
        const featureKey = Capnp.parsePacked(FeatureKey, verifiedFeatureKeyBlob);
        const filteredFeatureKey = _.pick(featureKey, ...FIELDS_PUBLISHED_TO_ADMINS);
        this.changed("featureKey", newDoc._id, filteredFeatureKey);
      } else {
        // Otherwise, call this.removed(), since the new feature key is invalid.
        this.removed("featureKey", oldDoc._id);
      }
    },

    removed: (oldDoc) => {
      this.removed("featureKey", oldDoc._id);
    },
  });

  this.onStop(() => {
    observeHandle.stop();
  });

  this.ready();
});
