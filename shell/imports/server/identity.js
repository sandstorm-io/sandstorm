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

import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import { _ } from "meteor/underscore";

import { SandstormDb } from "/imports/sandstorm-db/db.js";
import { globalDb } from "/imports/db-deprecated.js";
import { SandstormPermissions }  from "/imports/sandstorm-permissions/permissions.js";
import { PersistentImpl } from "/imports/server/persistent.js";
import { StaticAssetImpl, IdenticonStaticAssetImpl } from "/imports/server/static-asset.js";
import Capnp from "/imports/server/capnp.js";

const IdentityRpc = Capnp.importSystem("sandstorm/identity-impl.capnp");
const Identity = Capnp.importSystem("sandstorm/identity.capnp").Identity;
const StaticAsset = Capnp.importSystem("sandstorm/util.capnp").StaticAsset;

class IdentityImpl extends PersistentImpl {
  constructor(db, saveTemplate, accountId) {
    super(db, saveTemplate);
    this.accountId = accountId;
    this.db = db;
  }

  getProfile() {
    const user = Meteor.users.findOne({ _id: this.accountId });

    const profile = {
      displayName: { defaultText: user.profile.name },
      preferredHandle: user.profile.handle,
      pronouns: user.profile.pronoun,
    };

    if (user.profile.picture) {
      profile.picture = new Capnp.Capability(new StaticAssetImpl(user.profile.picture),
                                             StaticAsset);
    } else {
      const hash = user.profile.identicon;
      profile.picture = new Capnp.Capability(new IdenticonStaticAssetImpl(hash, 24),
                                             StaticAsset);
    }

    return { profile: profile };
  }
}

// TODO(cleanup): Find a better home for this.
const MembraneRequirement = Match.OneOf(
  { tokenValid: String },
  { permissionsHeld:
    { accountId: String, grainId: String, permissions: Match.Optional([Boolean]), }, },
  { permissionsHeld:
    { tokenId: String, grainId: String, permissions: Match.Optional([Boolean]), }, },
  { userIsAdmin: String });

makeIdentity = (accountId, requirements) => {
  const saveTemplate = { frontendRef: { identity: accountId } };
  if (requirements) {
    check(requirements, [MembraneRequirement]);
    saveTemplate.requirements = requirements;
  }

  return new Capnp.Capability(new IdentityImpl(globalDb, saveTemplate, accountId),
                              IdentityRpc.PersistentIdentity);
};

globalFrontendRefRegistry.register({
  frontendRefField: "identity",
  typeId: Identity.typeId,

  restore(db, saveTemplate, accountId) {
    return new Capnp.Capability(new IdentityImpl(db, saveTemplate, accountId),
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
      { accountId: session.userId, },
      session.grainId,
      "petname",
      value.roleAssignment,
      { user: { accountId: value.id, title: grain.title, }, });

    // TODO(soon): Somehow notify this user that they now have access.

    // TODO(perf): This permissions computation happens once here and then once again when the
    //   `permissionsHeld` requirement is checked. Is there a way to avoid the duplicated work?
    const permissions = SandstormPermissions.grainPermissions(
      db, { grain: { _id: session.grainId, accountId: value.id, }, },
      session.viewInfo ||  {}).permissions;

    return {
      descriptor: {
        tags: [
          {
            id: Identity.typeId,
            value: Capnp.serialize(
              Identity.PowerboxTag,
              {
                permissions: permissions,
              }),
          },
        ],
      },
      requirements: [
        {
          permissionsHeld: {
            accountId: value.id,
            grainId: session.grainId,
            permissions: [],
          },
        },
      ],
      frontendRef: value.id,
    };
  },

  query(db, userId, value) {
    const resultSet = {};
    let requestedPermissions = [];
    if (value) {
      requestedPermissions = Capnp.parse(Identity.PowerboxTag, value).permissions || [];
    }

    const resultForUser = function (user) {
      SandstormDb.fillInPictureUrl(user);
      return {
        _id: "frontendref-identity-" + user._id,
        frontendRef: { identity: user._id },
        cardTemplate: "identityPowerboxCard",
        configureTemplate: "identityPowerboxConfiguration",
        profile: user.profile,
        requestedPermissions,
        searchTerms: [
          user.profile.name,
          user.profile.handle,
          // TODO(someday): intrinsicName used to be here
        ],
      };
    };

    db.collections.contacts.find({ ownerId: userId }).forEach(contact => {
      const user = Meteor.users.findOne({ _id: contact.accountId });
      if (user) {
        resultSet[user._id] = resultForUser(user);
      }
    });

    if (db.getOrganizationShareContacts() &&
        db.isUserInOrganization(db.collections.users.findOne({ _id: userId }))) {

      // TODO(perf): Add some way to efficiently fetch all members in an organization.
      db.collections.users.find({ type: "credential" }).forEach((credential) => {
        if (db.isCredentialInOrganization(credential)) {
          const user = Meteor.users.findOne({ "loginCredentials.id": credential._id });
          if (user) {
            resultSet[user._id] = resultForUser(user);
          }
        }
      });
    }

    return _.values(resultSet);
  },
});
