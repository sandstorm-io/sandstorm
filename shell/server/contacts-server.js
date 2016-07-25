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

Meteor.publish("contactProfiles", function (showAll) {
  const db = this.connection.sandstormDb;
  const _this = this;
  const userId = this.userId;

  // We maintain a map from identity IDs to live query handles that track profile changes.
  const contactIdentities = {};
  const disallowGuests = db.getOrganizationDisallowGuests();

  function addIdentityOfContact(identityId) {
    if (!(identityId in contactIdentities)) {
      const user = Meteor.users.findOne({ _id: identityId });

      if (disallowGuests && !showAll) {
        if (!db.isIdentityInOrganization(user)) {
          return;
        }
      }

      if (user) {
        SandstormDb.fillInProfileDefaults(user);
        SandstormDb.fillInIntrinsicName(user);
        const filteredUser = _.pick(user, "_id", "profile");
        _this.added("contactProfiles", user._id, filteredUser);
      }

      contactIdentities[identityId] =
        Meteor.users.find({ _id: identityId }, { fields: { profile: 1 } }).observeChanges({
          changed: function (id, fields) {
            _this.changed("contactProfiles", id, fields);
          },
        });
    }
  }

  const cursor = db.collections.contacts.find({ ownerId: userId });

  const handle = cursor.observe({
    added: function (contact) {
      addIdentityOfContact(contact.identityId);
    },

    changed: function (contact) {
      addIdentityOfContact(contact.identityId);
    },

    removed: function (contact) {
      _this.removed("contactProfiles", contact.identityId);
      const contactIdentity = contactIdentities[contact.identityId];
      if (contactIdentity) contactIdentities[contact.identityId].stop();
      delete contactIdentities[contact.identityId];
    },
  });

  let orgHandle;

  if (db.getOrganizationShareContacts() &&
      db.isUserInOrganization(db.collections.users.findOne({ _id: userId }))) {
    const orgCursor = db.collections.users.find({ profile: { $exists: 1 } });
    // TODO(perf): make a mongo query that can find all identities in an organization and add
    // indices for it. Currently, we do some case insensitive matching which mongo can't
    // handle well.

    orgHandle = orgCursor.observe({
      added: function (user) {
        if (db.isIdentityInOrganization(user) && !db.userHasIdentity(userId, user._id)) {
          addIdentityOfContact(user._id);
        }
      },

      changed: function (user) {
        if (db.isIdentityInOrganization(user) && !db.userHasIdentity(userId, user._id)) {
          addIdentityOfContact(user._id);
        }
      },

      removed: function (user) {
        if (db.isIdentityInOrganization(user) && !db.userHasIdentity(userId, user._id)) {
          _this.removed("contactProfiles", user._id);
          const contactIdentity = contactIdentities[contact.identityId];
          if (contactIdentity) contactIdentities[contact.identityId].stop();
          delete contactIdentities[user._id];
        }
      },
    });
  }

  this.ready();

  this.onStop(function () {
    handle.stop();
    if (orgHandle) {
      orgHandle.stop();
    }

    Object.keys(contactIdentities).forEach(function (identityId) {
      contactIdentities[identityId].stop();
      delete contactIdentities[identityId];
    });
  });
});
