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

const Crypto = Npm.require("crypto");

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

        const grain = db.getGrain(saveTemplate.grainId);
        if (grain && grain.title !== userOwner.title) {
          userOwner.upstreamTitle = grain.title;
        }

        newToken.owner.user = userOwner;
      }

      const sturdyRef = generateSturdyRef();
      newToken._id = hashSturdyRef(sturdyRef);

      newToken.created = new Date();

      db.collections.apiTokens.insert(newToken);
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

export { PersistentImpl, hashSturdyRef, generateSturdyRef };
