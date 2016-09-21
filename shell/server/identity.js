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
const IdentityRpc = Capnp.importSystem("sandstorm/identity-impl.capnp");
const Identity = Capnp.importSystem("sandstorm/identity.capnp").Identity;
import { PersistentImpl } from "/imports/server/persistent.js";
import { StaticAssetImpl, IdenticonStaticAssetImpl } from "/imports/server/static-asset.js";
const StaticAsset = Capnp.importSystem("sandstorm/util.capnp").StaticAsset;

class IdentityImpl extends PersistentImpl {
  constructor(db, saveTemplate, identityId) {
    super(db, saveTemplate);
    this.identityId = identityId;
    this.db = db;
  }

  getProfile() {
    const identity = this.db.getIdentity(this.identityId);

    const profile = {
      displayName: { defaultText: identity.profile.name },
      preferredHandle: identity.profile.handle,
      pronouns: identity.profile.pronoun,
    };

    if (identity.profile.picture) {
      profile.picture = new Capnp.Capability(new StaticAssetImpl(identity.profile.picture),
                                             StaticAsset);
    } else {
      const hash = this.identityId.slice(0, 32);
      profile.picture = new Capnp.Capability(new IdenticonStaticAssetImpl(hash, 24),
                                             StaticAsset);
    }

    return { profile: profile };
  }
};

// TODO(cleanup): Find a better home for this.
const MembraneRequirement = Match.OneOf(
  { tokenValid: String },
  { permissionsHeld:
    { identityId: String, grainId: String, permissions: Match.Optional([Boolean]), }, },
  { permissionsHeld:
    { tokenId: String, grainId: String, permissions: Match.Optional([Boolean]), }, },
  { userIsAdmin: String });

makeIdentity = (identityId, requirements) => {
  const saveTemplate = { frontendRef: { identity: identityId } };
  if (requirements) {
    check(requirements, [MembraneRequirement]);
    saveTemplate.requirements = requirements;
  }

  return new Capnp.Capability(new IdentityImpl(globalDb, saveTemplate, identityId),
                              IdentityRpc.PersistentIdentity);
};

globalFrontendRefRegistry.register({
  frontendRefField: "identity",
  typeId: Identity.typeId,

  restore(db, saveTemplate, identityId) {
    return new Capnp.Capability(new IdentityImpl(db, saveTemplate, identityId),
                                IdentityRpc.PersistentIdentity);
  },

  validate(db, session, value) {
    check(value, { id: String, roleAssignment: SandstormDb.prototype.roleAssignmentPattern, });

    if (!session.userId) {
      throw new Meteor.Error(403, "Not logged in.");
    }

    const grain = db.getGrain(session.grainId);
    SandstormPermissions.createNewApiToken(
      db,
      { identityId: session.identityId,
        accountId: session.userId,
      },
      session.grainId,
      "petname",
      value.roleAssignment,
      { user: { identityId: value.id, title: grain.title, }, });

    return {
      descriptor: {
        tags: [
          {
            id: Identity.typeId,
            value: Capnp.serialize(
              Identity.PowerboxTag,
              { identityId: new Buffer(value.id, "hex"), }),
          },
        ],
      },
      requirements: [
        {
          permissionsHeld: {
            identityId: value.id,
            grainId: session.grainId,
            permissions: [],
          },
        },
      ],
      frontendRef: value.id,
    };
  },

  query(db, userId, value) {
    const result = [];
    db.collections.contacts.find({ ownerId: userId }).forEach(contact => {
      const identity = db.getIdentity(contact.identityId);
      result.push({
        _id: "frontendref-identity-" + contact.identityId,
        frontendRef: { identity: contact.identityId },
        cardTemplate: "identityPowerboxCard",
        configureTemplate: "identityPowerboxConfiguration",
        profile: identity.profile,
        searchTerms: [
          identity.profile.name,
          identity.profile.handle,
          identity.profile.intrinsicName,
        ],
      });
    });

    return result;
  },
});
