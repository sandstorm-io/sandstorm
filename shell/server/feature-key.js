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

import { send } from "/imports/server/email.js";
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
  // Set a new feature key. If the new key is expired, check with Sandstorm to see if it was
  // renewed, and use that copy instead.
  //
  // This function under no circumstances stores an expired key to the database, because once
  // a key is stored in the database it will be automatically renewed, and it would be surprising
  // to users if accidentally uploading an old key suddenly caused that key to be renewed.

  return setNewFeatureKeyInternal(db, textBlock, (expiredKey) => {
    // Key is expired. Try to fetch an updated copy.

    function throwExpired() {
      throw new Meteor.Error(401, "Feature key is expired. Please purchase a new key.");
    }

    try {
      const newTextBlock = fetchUpdatedFeautureKeyFromVendor(expiredKey);
      return setNewFeatureKeyInternal(db, newTextBlock, throwExpired);
    } catch (err) {
      console.error("couldn't fetch newer version of key", err);
    }

    // No luck.
    throwExpired();
  });
};

function setNewFeatureKeyInternal(db, textBlock, ifExpired) {
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

  if (parseInt(featureKey.expires) * 1000 < Date.now()) {
    return ifExpired(featureKey);
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

  let key;
  try {
    key = db.currentFeatureKey();
    if (!key) return;  // nothing to do

    // Count number of user accounts (not including visitors) active in the last month.
    let count = 0;
    const oneMonthAgo = new Date(Date.now() - 30 * 86400000);
    Meteor.users.find({ loginIdentities: { $exists: true }, lastActive: { $gt: oneMonthAgo } })
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
      reportRenewalProblem(db, key, options, { noPaymentSource: true });
    } else if (data.paymentFailed !== undefined) {
      reportRenewalProblem(db, key, options, { paymentFailed: data.paymentFailed });
    } else if (data.revoked !== undefined) {
      reportRenewalProblem(db, key, options, { revoked: true });
    } else if (data.noSuchKey !== undefined) {
      reportRenewalProblem(db, key, options, { noSuchKey: true });
    } else if (data.success !== undefined ||
               data.tooEarly !== undefined ||
               data.pendingPayment !== undefined) {
      // Either we successfully renewed the key, or the key had already been renewed out-of-band.
      // Either way, the next step is to fetch it.
      //
      // If we're doing a dry run, then the key wasn't actually updated so there's nothing to
      // fetch. However, if the server indicates that current key is newer than the one we have
      // here, then we should take this chance to update to the current key.
      if (!options.dryRun || parseInt(data.expires) > parseInt(key.expries)) {
        const newTextBlock = fetchUpdatedFeautureKeyFromVendor(key);
        setNewFeatureKeyInternal(db, newTextBlock, () => {
          throw new Error("Renewal seemed to succeed but the service returned an expired key. " +
                          "Is your system clock wrong?");
        });
      }
    } else {
      reportRenewalProblem(db, key, options, { unknownResponse: response.content });
    }
  } catch (err) {
    console.error("Exception when trying to renew feature key:", err.stack);
    reportRenewalProblem(db, key, options, { exception: err.message });
  }
};

function fetchUpdatedFeautureKeyFromVendor(key) {
  const fetchResponse = HTTP.get(RENEW_API_HOST + "/keys/" + key.secret.toString("hex"), {
    headers: {
      "Authorization": "Bearer " + RENEW_API_TOKEN,
    },
  });
  const result = fetchResponse.data.key;
  if (!result) throw new Error("Renewal server returned invalid GetKeyResponse.");
  return result;
}

function reportRenewalProblem(db, key, options, problem) {
  const old = db.collections.featureKey.findOne("currentFeatureKey");

  db.collections.featureKey.update("currentFeatureKey", { $set: { renewalProblem: problem } });

  console.error("Couldn't renew feature key:", problem);

  if (old && old.renewalProblem) {
    // There was already a renewal problem reported. Don't report again.
  } else if (!options.interactive) {
    if (key.isTrial) {
      db.sendAdminNotification("trialFeatureKeyExpired", "/admin/feature-key");
    } else {
      db.sendAdminNotification("cantRenewFeatureKey", "/admin/feature-key");
    }

    const emailOptions = {
      from: db.getReturnAddress(),
      subject: key.isTrial
          ? `URGENT: Sandstorm for Work trial for ${db.getServerTitle()} has expired`
          : `URGENT: Couldn't renew Sandstorm for Work subscription for ${db.getServerTitle()}`,
    };

    emailOptions.text = key.isTrial
        ? "This is an automated message from your Sandstorm server. Your trial of Sandstorm for Work has expired. To continue using Sandstorm for Work, update your subscription here:"
        : "This is an automated message from your Sansdtorm server. There was an error when trying to renew your Sandstorm for Work subscription. To resolve the issue, please go to:";

    emailOptions.text += `

${process.env.ROOT_URL}/admin/feature-key`;

    Meteor.users.find({ isAdmin: true }).forEach((user) => {
      const email = _.findWhere(SandstormDb.getUserEmails(user), { primary: true });
      if (!email) {
        console.error("No email found for admin with userId:", user._id);
        return;
      }

      try {
        emailOptions.to = email.email;
        send(emailOptions);
      } catch (err) {
        console.error(
          `Failed to send deletion email to admin (id=${user._id}) with error: ${err}`);
      }
    });
  }
}

let keyRenewalTimeout = null;
let keyObserver = null;
let currentlyRenewing = false;
keepFeatureKeyRenewed = function (db) {
  // Whenever the feature key is expired, try to renew it.

  if (keyObserver) keyObserver.stop();

  keyObserver = db.observeFeatureKey(key => {
    if (keyRenewalTimeout) {
      Meteor.clearTimeout(keyRenewalTimeout);
      keyRenewalTimeout = null;
    }

    if (!key) return;

    function scheduleRenewal() {
      keyRenewalTimeout = null;

      // Fucking Javascript setTimeout() treats any timeout longer than 2^31 as zero. Documented
      // behavior. Same across all browsers. Node.js has its own custom setTimeout() implementation
      // and still does it. WHHHHYYYYYYYYYYY?
      //
      // So instead we cap the delay and we re-check the time in the callback.
      const delay = Math.min(1e9, parseInt(key.expires) * 1000 - Date.now());
      if (delay > 0) {
        keyRenewalTimeout = Meteor.setTimeout(scheduleRenewal, delay);
        return;
      }

      // OK, ready to renew now. Do it.

      // Careful that flapping doesn't cause us to make concurrent calls.
      if (!currentlyRenewing) {
        currentlyRenewing = true;
        try {
          renewFeatureKey(db);
        } finally {
          currentlyRenewing = false;
        }
      }
    }

    scheduleRenewal();
  });
};
