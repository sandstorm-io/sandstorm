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

  // We maintain a map from identity IDs to live query handles that track profile changes.
  const contactIdentities = {};
  const disallowGuests = db.getOrganizationDisallowGuests();

  function addIdentityOfContact(contact) {
    if (!(contact.identityId in contactIdentities)) {
      const user = Meteor.users.findOne({ _id: contact.identityId });

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

      contactIdentities[contact.identityId] =
        Meteor.users.find({ _id: contact.identityId }, { fields: { profile: 1 } }).observeChanges({
          changed: function (id, fields) {
            _this.changed("contactProfiles", id, fields);
          },
        });
    }
  }

  const cursor = db.collections.contacts.find({ ownerId: this.userId });

  const handle = cursor.observe({
    added: function (contact) {
      addIdentityOfContact(contact);
    },

    changed: function (contact) {
      addIdentityOfContact(contact);
    },

    removed: function (contact) {
      _this.removed("contactProfiles", contact.identityId);
      contactIdentities[contact.identityId].stop();
      delete contactIdentities[contact.identityId];
    },
  });
  this.ready();

  this.onStop(function () {
    handle.stop();
    Object.keys(contactIdentities).forEach(function (identityId) {
      contactIdentities[identityId].stop();
      delete contactIdentities[identityId];
    });
  });
});
