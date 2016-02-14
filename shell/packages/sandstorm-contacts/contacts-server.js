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

Meteor.publish("contactProfiles", function () {
  var db = this.connection.sandstormDb;
  var self = this;

  // We maintain a map from identity IDs to live query handles that track profile changes.
  var contactIdentities = {};

  var self = this;
  function addIdentityOfContact(contact) {
    if (!(contact.identityId in contactIdentities)) {
      var user = Meteor.users.findOne({ _id: contact.identityId });
      if (user) {
        SandstormDb.fillInProfileDefaults(user);
        SandstormDb.fillInIntrinsicName(user);
        var filteredUser = _.pick(user, "_id", "profile");
        self.added("contactProfiles", user._id, filteredUser);
      }

      contactIdentities[contact.identityId] =
        Meteor.users.find({ _id: contact.identityId }, { fields: { profile: 1 } }).observeChanges({
          changed: function (id, fields) {
            self.changed("contactProfiles", id, fields);
          },
        });
    }
  }

  var cursor = db.collections.contacts.find({ ownerId: this.userId });

  var handle = cursor.observe({
    added: function (contact) {
      addIdentityOfContact(contact);
    },

    changed: function (contact) {
      addIdentityOfContact(contact);
    },

    removed: function (contact) {
      self.removed("contactProfiles", contact.identityId);
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
