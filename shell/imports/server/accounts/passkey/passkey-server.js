import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import { Random } from "meteor/random";
import { Accounts } from "meteor/accounts-base";
import { SHA256 } from "meteor/sha";
import { Crypto } from "@peculiar/webcrypto";

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

import { SandstormDb } from "/imports/sandstorm-db/db";
import { globalDb } from "/imports/db-deprecated";

if (!Promise.any) {
  Promise.any = function (promises) {
    return new Promise((resolve, reject) => {
      const errors = [];
      let pending = 0;
      let settled = false;

      for (const promise of promises) {
        const index = pending++;
        Promise.resolve(promise).then((value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        }, (err) => {
          errors[index] = err;
          pending--;
          if (!settled && pending === 0) {
            const aggregateError = new Error("All promises were rejected");
            aggregateError.name = "AggregateError";
            aggregateError.errors = errors;
            reject(aggregateError);
          }
        });
      }

      if (pending === 0) {
        const aggregateError = new Error("All promises were rejected");
        aggregateError.name = "AggregateError";
        aggregateError.errors = errors;
        reject(aggregateError);
      }
    });
  };
}

if (!globalThis.crypto || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: new Crypto(),
    configurable: true,
  });
}

// Challenge storage: in-memory Map keyed by connection.id
// Challenges expire after 5 minutes and are single-use.
const CHALLENGE_EXPIRY_MS = 5 * 60 * 1000;
const pendingChallenges = new Map();
// Keep Node 14/polyfilled WebCrypto on broadly-supported ES256/RS256 and avoid Ed25519.
const SUPPORTED_PASSKEY_ALGORITHMS = [-7, -257];
const MAX_PASSKEY_NAME_LENGTH = 100;

function storeChallenge(connectionId, challenge, userHandle) {
  pendingChallenges.set(connectionId, {
    challenge,
    userHandle: userHandle || null,
    createdAt: Date.now(),
  });
}

function consumeChallenge(connectionId) {
  const entry = pendingChallenges.get(connectionId);
  pendingChallenges.delete(connectionId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CHALLENGE_EXPIRY_MS) return null;
  return { challenge: entry.challenge, userHandle: entry.userHandle };
}

// Periodic cleanup of expired challenges
SandstormDb.periodicCleanup(CHALLENGE_EXPIRY_MS, function () {
  const now = Date.now();
  for (const [key, entry] of pendingChallenges) {
    if (now - entry.createdAt > CHALLENGE_EXPIRY_MS) {
      pendingChallenges.delete(key);
    }
  }
});

function getRpId() {
  return new URL(Meteor.absoluteUrl()).hostname;
}

function getExpectedOrigin() {
  const url = Meteor.absoluteUrl();
  // Strip trailing slash
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// Base64url encode/decode helpers for public key storage
function uint8ArrayToBase64url(uint8Array) {
  return Buffer.from(uint8Array).toString("base64url");
}

function base64urlToUint8Array(base64url) {
  return new Uint8Array(Buffer.from(base64url, "base64url"));
}

function checkPasskeyNameLength(name) {
  if (name.length > MAX_PASSKEY_NAME_LENGTH) {
    throw new Meteor.Error(
      400, "Passkey name must be " + MAX_PASSKEY_NAME_LENGTH + " characters or fewer."
    );
  }
}

function defaultPasskeyName(now) {
  return "Passkey (" + now.toISOString().slice(0, 10) + ")";
}

Meteor.methods({
  "passkey.generateRegistrationOptions": async function () {
    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to register a passkey.");
    }

    if (!Accounts.loginServices.passkey.isEnabled()) {
      throw new Meteor.Error(403, "Passkey login service is disabled.");
    }

    // Find existing passkey credential for this account, if any
    const account = Meteor.users.findOne({ _id: this.userId });
    if (!account || !account.loginCredentials) {
      throw new Meteor.Error(403, "Must be logged in to an account.");
    }

    let userHandle;
    let existingKeys = [];
    // Look through linked credentials for an existing passkey credential
    for (const cred of account.loginCredentials) {
      const credUser = Meteor.users.findOne({ _id: cred.id });
      if (credUser && credUser.services && credUser.services.passkey) {
        userHandle = credUser.services.passkey.userHandle;
        existingKeys = credUser.services.passkey.keys || [];
        break;
      }
    }

    // Generate a new userHandle if no existing passkey credential
    if (!userHandle) {
      userHandle = Random.secret(32);
    }

    const rpID = getRpId();
    const rpName = globalDb.getServerTitle() || "Sandstorm";

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      challenge: Random.secret(32),
      userName: rpID,
      userDisplayName: "Sandstorm User",
      userID: new TextEncoder().encode(userHandle),
      excludeCredentials: existingKeys.map(function (key) {
        return {
          id: key.credentialId,
          transports: key.transports,
        };
      }),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "preferred",
      },
      supportedAlgorithmIDs: SUPPORTED_PASSKEY_ALGORITHMS,
      attestation: "none",
      timeout: 300000,
    });

    storeChallenge(this.connection.id, options.challenge, userHandle);

    return { options };
  },

  "passkey.verifyRegistration": async function (attestationResponse, friendlyName) {
    check(attestationResponse, Object);
    check(friendlyName, Match.Maybe(String));
    const requestedName = friendlyName ? friendlyName.trim() : "";
    checkPasskeyNameLength(requestedName);

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to register a passkey.");
    }

    if (!Accounts.loginServices.passkey.isEnabled()) {
      throw new Meteor.Error(403, "Passkey login service is disabled.");
    }

    const challengeData = consumeChallenge(this.connection.id);
    if (!challengeData) {
      throw new Meteor.Error(403, "Challenge expired or not found. Please try again.");
    }
    const { challenge: expectedChallenge, userHandle } = challengeData;
    if (!userHandle) {
      throw new Meteor.Error(403, "Challenge expired or not found. Please try again.");
    }

    const rpID = getRpId();
    const expectedOrigin = getExpectedOrigin();

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: attestationResponse,
        expectedChallenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: false,
        supportedAlgorithmIDs: SUPPORTED_PASSKEY_ALGORITHMS,
      });
    } catch (err) {
      throw new Meteor.Error(403, "Passkey registration failed: " + err.message);
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new Meteor.Error(403, "Passkey registration failed.");
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    const now = new Date();
    const name = requestedName || defaultPasskeyName(now);

    const keyEntry = {
      credentialId: credential.id,
      publicKey: uint8ArrayToBase64url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports || [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      friendlyName: name,
      createdAt: now,
      lastUsedAt: now,
    };

    // Check if account already has a passkey credential linked
    const account = Meteor.users.findOne({ _id: this.userId });
    let passkeyCredentialId = null;

    for (const cred of (account.loginCredentials || [])) {
      const credUser = Meteor.users.findOne({ _id: cred.id });
      if (credUser && credUser.services && credUser.services.passkey) {
        passkeyCredentialId = credUser._id;
        break;
      }
    }

    if (passkeyCredentialId) {
      // Existing passkey credential: add new key
      Meteor.users.update(
        { _id: passkeyCredentialId },
        { $push: { "services.passkey.keys": keyEntry } }
      );
    } else {
      // New passkey credential: create credential user and link to account
      const credentialUserId = SHA256("passkey:" + userHandle);
      const user = {
        _id: credentialUserId,
        services: {
          passkey: {
            userHandle: userHandle,
            keys: [keyEntry],
          },
        },
      };

      Accounts.insertUserDoc({}, user);

      Accounts.linkCredentialToAccount(
        this.connection.sandstormDb,
        this.connection.sandstormBackend,
        credentialUserId,
        this.userId,
        true // allowLogin
      );
    }

    return { credentialId: credential.id, friendlyName: name };
  },

  "passkey.generateAuthenticationOptions": async function () {
    if (!Accounts.loginServices.passkey.isEnabled()) {
      throw new Meteor.Error(403, "Passkey login service is disabled.");
    }

    const rpID = getRpId();

    const options = await generateAuthenticationOptions({
      rpID,
      challenge: Random.secret(32),
      allowCredentials: [],
      userVerification: "preferred",
      timeout: 300000,
    });

    storeChallenge(this.connection.id, options.challenge);

    return options;
  },

  "passkey.rename": function (credentialId, newName) {
    check(credentialId, String);
    check(newName, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in.");
    }

    const name = newName.trim();
    if (!name) {
      throw new Meteor.Error(400, "Name cannot be empty.");
    }
    checkPasskeyNameLength(name);

    const account = Meteor.users.findOne({ _id: this.userId });
    if (!account || !account.loginCredentials) {
      throw new Meteor.Error(403, "Must be logged in to an account.");
    }

    const allCredentials = (account.loginCredentials || []).concat(account.nonloginCredentials || []);
    for (const cred of allCredentials) {
      const result = Meteor.users.update(
        {
          _id: cred.id,
          "services.passkey.keys.credentialId": credentialId,
        },
        {
          $set: { "services.passkey.keys.$.friendlyName": name },
        }
      );
      if (result > 0) return;
    }

    throw new Meteor.Error(404, "Passkey not found.");
  },

  "passkey.remove": function (credentialId) {
    check(credentialId, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in.");
    }

    const account = Meteor.users.findOne({ _id: this.userId });
    if (!account || !account.loginCredentials) {
      throw new Meteor.Error(403, "Must be logged in to an account.");
    }

    const allCredentials = (account.loginCredentials || []).concat(account.nonloginCredentials || []);
    for (const cred of allCredentials) {
      const credUser = Meteor.users.findOne({ _id: cred.id });
      if (!credUser || !credUser.services || !credUser.services.passkey) continue;

      const keys = credUser.services.passkey.keys || [];
      const keyIndex = keys.findIndex(function (k) { return k.credentialId === credentialId; });
      if (keyIndex === -1) continue;

      if (keys.length === 1) {
        // Last key: remove entire credential and unlink from account
        Meteor.users.update(
          { _id: this.userId },
          { $pull: {
            loginCredentials: { id: cred.id },
            nonloginCredentials: { id: cred.id },
          } }
        );
        Meteor.users.remove({ _id: cred.id });
      } else {
        // Remove just this key
        Meteor.users.update(
          { _id: cred.id },
          { $pull: { "services.passkey.keys": { credentialId: credentialId } } }
        );
      }

      return;
    }

    throw new Meteor.Error(404, "Passkey not found.");
  },
});

// Login handler
Accounts.registerLoginHandler("passkey", async function (options) {
  if (!options.passkey) return undefined;

  if (!Accounts.loginServices.passkey.isEnabled()) {
    throw new Meteor.Error(403, "Passkey login service is disabled.");
  }

  check(options.passkey, Object);

  const connectionId = this.connection.id;
  const challengeData = consumeChallenge(connectionId);
  if (!challengeData) {
    throw new Meteor.Error(403, "Challenge expired or not found.");
  }
  const expectedChallenge = challengeData.challenge;

  // Find credential user by credentialId
  const authResponseId = options.passkey.id;
  const credentialUser = Meteor.users.findOne({
    "services.passkey.keys.credentialId": authResponseId,
  });

  if (!credentialUser) {
    return { error: new Meteor.Error(403, "Passkey not recognized.") };
  }

  const keys = credentialUser.services.passkey.keys;
  const matchingKey = keys.find(function (k) { return k.credentialId === authResponseId; });

  if (!matchingKey) {
    return { error: new Meteor.Error(403, "Passkey not recognized.") };
  }

  const rpID = getRpId();
  const expectedOrigin = getExpectedOrigin();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: options.passkey,
      expectedChallenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: matchingKey.credentialId,
        publicKey: base64urlToUint8Array(matchingKey.publicKey),
        counter: matchingKey.counter,
        transports: matchingKey.transports,
      },
    });
  } catch (err) {
    console.error("Passkey authentication failed:", err.message);
    return { error: new Meteor.Error(403, "Passkey authentication failed.") };
  }

  if (!verification.verified) {
    return { error: new Meteor.Error(403, "Passkey authentication failed.") };
  }

  const { newCounter, credentialBackedUp } = verification.authenticationInfo;

  // Update credential state
  Meteor.users.update(
    {
      _id: credentialUser._id,
      "services.passkey.keys.credentialId": authResponseId,
    },
    {
      $set: {
        "services.passkey.keys.$.counter": newCounter,
        "services.passkey.keys.$.backedUp": credentialBackedUp,
        "services.passkey.keys.$.lastUsedAt": new Date(),
      },
    }
  );

  return { userId: credentialUser._id };
});
