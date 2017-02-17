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

import { inMeteor } from "/imports/server/async-helpers.js";

const Crypto = Npm.require("crypto");
const Capnp = Npm.require("capnp");

const privateDb = Symbol("PersistentImpl.db");
const privateTemplate = Symbol("PersistentImpl.template");
const privateIsSaved = Symbol("PersistentImpl.isSaved");

class PersistentImpl {
  constructor(db, saveTemplate) {
    this[privateDb] = db;
    this[privateTemplate] = saveTemplate;

    // TODO(someday): This may or may not be quite right in cases where we're saving a root token
    //   by copy. Is the copy the "same" capability or not? Today, isSaved() is only used by
    //   wakelock notification handles which are not issued through the powerbox, therefore do not
    //   go through claimRequest(), therefore are not saved by copy, so the point is moot.
    this[privateIsSaved] = !!saveTemplate.parentToken;
  }

  isSaved() {
    // Can be called by subclasses to ask whether or not a record currently exists in the ApiTokens
    // table representing this capability.

    return this[privateIsSaved];
  }

  save(params) {
    return inMeteor(() => {
      if (!params.sealFor) {
        throw new Error("must specify 'sealFor'");
      }

      const db = this[privateDb];

      const newToken = _.clone(this[privateTemplate]);
      newToken.owner = params.sealFor;
      if (newToken.owner.user) {
        if (!newToken.identityId) {
          throw new Error("can't save non-UiView with user as owner");
        }

        // Only "identityId" and "title" are allowed to be passed to save().
        const userOwner = _.pick(newToken.owner.user, "identityId", "title");

        // Fill in denormalizedGrainMetadata and upstreamTitle ourselves.
        userOwner.denormalizedGrainMetadata = db.getDenormalizedGrainInfo(newToken.grainId);

        const grain = db.getGrain(newToken.grainId);
        if (grain && grain.title !== userOwner.title) {
          userOwner.upstreamTitle = grain.title;
        }

        newToken.owner.user = userOwner;
      }

      newToken.created = new Date();
      const sturdyRef = insertApiToken(db, newToken);

      this[privateIsSaved] = true;
      return { sturdyRef: new Buffer(sturdyRef) };
    });
  }

  // TODO(someday): Implement SystemPersistent.addRequirements().
}

function hashSturdyRef(sturdyRef) {
  return Crypto.createHash("sha256").update(sturdyRef).digest("base64");
};

function generateSturdyRef() {
  return Random.secret();
}

function cryptApiToken(key, entry, cryptIn, cryptOut) {
  // Encrypts or decrypts all fields of an ApiToken.
  // `cryptIn` translates a token in the input to a buffer.
  // `cryptOut` translates a buffer to a token in the output.

  check(key, String);
  check(entry, Object);

  const nonce0 = new Buffer(8);
  nonce0.fill(0);

  const keyBuf = new Buffer(32);
  keyBuf.fill(0);
  keyBuf.write(key, 0, 32, "base64");

  function encrypt0(token) {
    return cryptOut(Capnp.chacha20(cryptIn(token), nonce0, keyBuf));
  }

  if (entry.parentTokenKey) {
    entry.parentTokenKey = encrypt0(entry.parentTokenKey);
  } else if (entry.frontendRef && entry.frontendRef.http) {
    const http = entry.frontendRef.http;
    if (http.auth) {
      const auth = http.auth;
      if (auth.bearer) {
        auth.bearer = encrypt0(auth.bearer);
      } else if (auth.basic) {
        auth.basic.password = encrypt0(auth.basic.password);
      } else if (auth.refresh) {
        auth.refresh = encrypt0(auth.refresh);
      }
    }
  }
}

function fetchApiToken(db, key, moreQuery) {
  // Reads an ApiToken from the database and decrypts its encrypted fields.

  function bufferToString(buf) {
    // un-pad short secrets
    let size = buf.length;
    while (size > 0 && buf[size - 1] == 0) {
      --size;
    }

    return buf.slice(0, size).toString("utf8");
  }

  const query = { _id: hashSturdyRef(key) };
  Object.assign(query, moreQuery || {});
  const entry = db.collections.apiTokens.findOne(query);
  if (entry) {
    cryptApiToken(key, entry, x => x, bufferToString);
  }

  return entry;
}

function insertApiToken(db, entry, key) {
  // Adds a new ApiToken to the database. `key`, if specified, *must* be a base64-encoded 256-bit
  // value. If omitted, a key will be generated. Either way, the key is returned, and entry._id
  // is filled in. Also, as a side effect, some fields of `entry` will become encrypted, but
  // ideally callers should not depend on this behavior.

  function stringToBuffer(str) {
    const buf = new Buffer(str, "utf8");
    if (buf.length >= 32) return buf;

    const padded = new Buffer(32);
    padded.fill(0);
    buf.copy(padded);
    return padded;
  }

  if (!key) key = generateSturdyRef();
  entry._id = hashSturdyRef(key);
  cryptApiToken(key, entry, stringToBuffer, x => x);
  db.collections.apiTokens.insert(entry);
  return key;
}

function checkRequirements(db, requirements) {
  // Checks if the given list of MembraneRequirements are all satisfied, returning true if so and
  // false otherwise.

  // TODO(cleanup): SandstormPermissions has a different way of checking the same requirements.
  //   Reuse?

  // TODO(security): Eventually we want checkRequirements(), when it passes, to produce an observer
  //   that can be used to receive a notification when the requirements may no longer be satisfied,
  //   in order to revoke the live object. See RequirementObserver in supervisor.capnp.

  if (!requirements) {
    return true;
  }

  requirements.forEach(requirement => {
    if (requirement.tokenValid) {
      const token = db.collections.apiTokens.findOne(
          { _id: requirement.tokenValid, revoked: { $ne: true }, },
          { fields: { requirements: 1 } });
      if (!token) {
        throw new Meteor.Error(403,
            "Capability revoked because the link through which it was introduced has been " +
            "revoked or deleted.");
      }

      checkRequirements(db, token.requirements);

      if (token.parentToken) {
        checkRequirements(db, [{ tokenValid: token.parentToken }]);
      }
    } else if (requirement.permissionsHeld) {
      const p = requirement.permissionsHeld;
      const viewInfo = db.collections.grains.findOne(
          p.grainId, { fields: { cachedViewInfo: 1 } }).cachedViewInfo;
      let vertex;
      if (p.identityId) {
        vertex = { grain: { _id: p.grainId, identityId: p.identityId } };
      } else {
        vertex = { token: { _id: p.tokenId, grainId: p.grainId } };
      }

      const currentPermissions = SandstormPermissions.grainPermissions(db,
          vertex, viewInfo || {}).permissions;
      if (!currentPermissions) {
        throw new Meteor.Error(403,
            "Capability revoked because a user involved in introducing it no longer has " +
            "the necessary permissions.");
      }

      const requiredPermissions = p.permissions || [];
      for (let ii = 0; ii < requiredPermissions.length; ++ii) {
        if (requiredPermissions[ii] && !currentPermissions[ii]) {
          throw new Meteor.Error(403,
              "Capability revoked because a user involved in introducing it no longer has " +
              "the necessary permissions.");
        }
      }
    } else if (requirement.userIsAdmin) {
      if (!db.isAdminById(requirement.userIsAdmin)) {
        throw new Meteor.Error(403,
            "Capability revoked because the user who created it has lost their admin " +
            "rights.");
      }
    } else {
      throw new Meteor.Error(403, "Unknown requirement type.");
    }
  });
};

export {
  PersistentImpl, hashSturdyRef, generateSturdyRef, checkRequirements,
  fetchApiToken, insertApiToken,
};
