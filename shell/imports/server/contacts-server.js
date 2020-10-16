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
import { _ } from "meteor/underscore";

Meteor.publish("contactProfiles", function (showAll) {
  const db = this.connection.sandstormDb;
  const _this = this;
  const userId = this.userId;

  // We maintain a map from account IDs to live query handles that track profile changes.
  const contactAccounts = {};
  const disallowGuests = db.getOrganizationDisallowGuests();

  function addAccountOfContact(accountId) {
    if (!(accountId in contactAccounts)) {
      const user = Meteor.users.findOne({ _id: accountId });

      if (disallowGuests && !showAll) {
        if (!db.isUserInOrganization(user)) {
          return;
        }
      }

      if (user) {
        const filteredUser = _.pick(user, "_id", "profile");
        filteredUser.intrinsicNames = db.getAccountIntrinsicNames(user, false);
        _this.added("contactProfiles", user._id, filteredUser);
      }

      contactAccounts[accountId] =
        Meteor.users.find({ _id: accountId }, { fields: { profile: 1 } }).observeChanges({
          changed: function (id, fields) {
            _this.changed("contactProfiles", id, fields);
          },
        });
    }
  }

  const cursor = db.collections.contacts.find({ ownerId: userId });

  const handle = cursor.observe({
    added: function (contact) {
      addAccountOfContact(contact.accountId);
    },

    changed: function (contact) {
      addAccountOfContact(contact.accountId);
    },

    removed: function (contact) {
      _this.removed("contactProfiles", contact.accountId);
      const contactAccount = contactAccounts[contact.accountId];
      if (contactAccount) contactAccounts[contact.accountId].stop();
      delete contactAccounts[contact.accountId];
    },
  });

  let orgHandle;

  if (db.getOrganizationShareContacts() &&
      db.isUserInOrganization(db.collections.users.findOne({ _id: userId }))) {
    const orgCursor = db.collections.users.find({ type: "account" });
    // TODO(perf): make a mongo query that can find all accounts in an organization and add
    // indices for it. Currently, we do some case insensitive matching which mongo can't
    // handle well.

    orgHandle = orgCursor.observe({
      added: function (user) {
        if (db.isUserInOrganization(user) && user._id !== userId) {
          addAccountOfContact(user._id);
        }
      },

      changed: function (user) {
        if (db.isUserInOrganization(user) && user._id !== userId) {
          addAccountOfContact(user._id);
        }
      },

      removed: function (user) {
        if (db.isUserInOrganization(user) && user._id !== userId) {
          _this.removed("contactProfiles", user._id);
          const contactAccount = contactAccounts[contact.accountId];
          if (contactAccount) contactAccounts[contact.accountId].stop();
          delete contactAccounts[user._id];
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

    Object.keys(contactAccounts).forEach(function (accountId) {
      contactAccounts[accountId].stop();
      delete contactAccounts[accountId];
    });
  });
});
