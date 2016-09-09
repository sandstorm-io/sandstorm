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
    const featureKey = Capnp.parse(FeatureKey, verifiedFeatureKeyBlob, { packed: true });
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

setNewFeatureKey = function (db, textBlock) {
  if (!textBlock) {
    // Delete the feature key.
    db.collections.featureKey.remove("currentFeatureKey");
    return;
  }

  // textBlock is a base64'd string, possibly with newlines and comment lines starting with "-"
  const featureKeyBase64 = _.chain(textBlock.split("\n"))
      .filter(line => (line.length > 0 && line[0] !== "-"))
      .value()
      .join("");

  const buf = new Buffer(featureKeyBase64, "base64");
  if (buf.length < 64) {
    throw new Meteor.Error(401, "Invalid feature key");
  }

  const featureKey = loadSignedFeatureKey(buf);
  if (!featureKey) {
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
}

// =======================================================================================
// Renewal

const RENEW_API_HOST = "https://api.oasis.sandstorm.io";
const RENEW_API_TOKEN = "objFPmEL0gOGfwKYLIwHNmfdKp1FCgMNSrxW4lEeeLk";

renewFeatureKey = function (db, options) {
  // Attempts to renew the current feature key.
  //
  // If any errors are detected, admins will be notified and the error information will be stored
  // to the database for display on the feature key page.
  //
  // `options` is an object optionally containing:
  //   interactive: Set true if the function was called in response to an admin interactively
  //     requesting the action. This suppresses sending notifications on error, as the admin
  //     will see the error message on the feature key page.
  //   dryRun: Go through as many of the motions of renewing as possible without actually renewing,
  //     in order to detect and report if anything would go wrong, and also detect if a newer key
  //     is already available. Useful to test for problems and warn the administrators in advance.

  options = options || {};

  try {
    const key = db.currentFeatureKey();
    if (!key) return;  // nothing to do

    // Count number of user accounts (not including visitors) active in the last month.
    let count = 0;
    const oneMonthAgo = new Date(Date.now() - 30 * 86400000);
    Meteor.users.find({loginIdentities: {$exists: true}, lastActive: {$gt: oneMonthAgo}})
        .forEach(user => {
      if (db.isAccountSignedUp(user)) {
        ++count;
      }
    });

    console.log("Attempting to renew fetaure key. Active users:", count);

    // Request renewal.
    const response = HTTP.post(RENEW_API_HOST + "/renew/" + key.secret.toString("hex"), {
      headers: {
        "Authorization": "Bearer " + RENEW_API_TOKEN,
      },
      data: {
        activeUsers: count,
        dryRun: options.dryRun,
      },
    });

    const data = response.data;
    if (data.noPaymentSource !== undefined) {
      reportRenewalProblem(db, options, {noPaymentSource: true});
    } else if (data.paymentFailed !== undefined) {
      reportRenewalProblem(db, options, {paymentFailed: data.paymentFailed});
    } else if (data.revoked !== undefined) {
      reportRenewalProblem(db, options, {revoked: true});
    } else if (data.noSuchKey !== undefined) {
      reportRenewalProblem(db, options, {noSuchKey: true});
    } else if (data.success !== undefined ||
               data.tooEarly !== undefined ||
               data.pendingPayment !== undefined) {
      // Either we successfully renewed the key, or the key had already been renewed out-of-band.
      // Either way, the next step is to fetch it.
      //
      // If we're doing a dry run, then the key wasn't actually updated so there's nothing to
      // fetch. However, if the server indicates that current key is newer than the one we have
      // here, then we should take this chance to update to the current key.
      if (!options.dryRun || data.expires > key.expries) {
        refreshFeatureKey(db);
      }
    } else {
      reportRenewalProblem(db, options, {unknownResponse: response.content});
    }
  } catch (err) {
    console.error("Exception when trying to renew feature key:", err.stack);
    reportRenewalProblem(db, options, {exception: err.message});
  }
}

function refreshFeatureKey(db) {
  // Check the feature key vendor to see if it has a new version of our key and, if so, download
  // it now.

  const key = db.currentFeatureKey();
  if (!key) return;  // nothing to do

  const fetchResponse = HTTP.get(RENEW_API_HOST + "/keys/" + key.secret.toString("hex"), {
    headers: {
      "Authorization": "Bearer " + RENEW_API_TOKEN,
    }
  });
  setNewFeatureKey(db, fetchResponse.data.key);
}

function reportRenewalProblem(db, options, problem) {
  db.collections.featureKey.update("currentFeatureKey", { $set: { renewalProblem: problem } });

  if (!options.interactive) {
    // TODO(now):
    // - If not interactive, email admins.
    // - If not interactive, notify admins via bell menu.
  }
}
