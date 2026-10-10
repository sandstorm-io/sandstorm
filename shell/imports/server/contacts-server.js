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

Meteor.publish("contactProfiles", async function (showAll) {
  const db = this.connection.sandstormDb;
  const _this = this;
  const userId = this.userId;

  // We maintain a map from account IDs to live query handles that track profile changes.
  const contactAccounts = {};
  const disallowGuests = await db.getOrganizationDisallowGuestsAsync();

  function removeAccountOfContact(accountId) {
    _this.removed("contactProfiles", accountId);
    const contactAccount = contactAccounts[accountId];
    if (contactAccount) {
      Promise.resolve(contactAccount).then((h) => {
        if (typeof h === "function") { h(); } else if (h && typeof h.stop === "function") h.stop();
      }).catch((err) => {
        console.error(`Failed to stop contact account observer for ${accountId}:`, err);
      });
    }
    delete contactAccounts[accountId];
  }

  async function addAccountOfContact(accountId) {
    if (!(accountId in contactAccounts)) {
      const user = await Meteor.users.findOneAsync({ _id: accountId });

      if (disallowGuests && !showAll) {
        if (!await db.isUserInOrganizationAsync(user)) {
          return;
        }
      }

      if (user) {
        const filteredUser = _.pick(user, "_id", "profile");
        filteredUser.intrinsicNames = await db.getAccountIntrinsicNamesAsync(user, false);
        _this.added("contactProfiles", user._id, filteredUser);
      }

      contactAccounts[accountId] =
        await Meteor.users.find({ _id: accountId }, { fields: { profile: 1 } }).observeChangesAsync({
          changed: function (id, fields) {
            _this.changed("contactProfiles", id, fields);
          },
        });
    }
  }

  const cursor = db.collections.contacts.find({ ownerId: userId });

  const handle = await cursor.observeAsync({
    added: function (contact) {
      addAccountOfContact(contact.accountId).catch((err) => {
        console.error("Failed to add contact account (added):", err);
      });
    },

    changed: function (contact) {
      addAccountOfContact(contact.accountId).catch((err) => {
        console.error("Failed to add contact account (changed):", err);
      });
    },

    removed: function (contact) {
      removeAccountOfContact(contact.accountId);
    },
  });

  let orgHandle;

  const ownerUser = await db.collections.users.findOneAsync({ _id: userId });
  if (await db.getOrganizationShareContacts() &&
      await db.isUserInOrganizationAsync(ownerUser)) {
    const orgCursor = db.collections.users.find({ type: "account" });
    // TODO(perf): make a mongo query that can find all accounts in an organization and add
    // indices for it. Currently, we do some case insensitive matching which mongo can't
    // handle well.

    orgHandle = await orgCursor.observeAsync({
      added: function (user) {
        db.isUserInOrganizationAsync(user).then((inOrg) => {
          if (inOrg && user._id !== userId) {
            addAccountOfContact(user._id).catch((err) => {
              console.error("Failed to add contact account (org added):", err);
            });
          }
        }).catch((err) => {
          console.error("Failed to evaluate organization membership (org added):", err);
        });
      },

      changed: function (user) {
        db.isUserInOrganizationAsync(user).then((inOrg) => {
          if (inOrg && user._id !== userId) {
            addAccountOfContact(user._id).catch((err) => {
              console.error("Failed to add contact account (org changed):", err);
            });
          } else if (user._id !== userId) {
            removeAccountOfContact(user._id);
          }
        }).catch((err) => {
          console.error("Failed to evaluate organization membership (org changed):", err);
        });
      },

      removed: function (user) {
        if (user._id !== userId) {
          removeAccountOfContact(user._id);
        }
      },
    });
  }

  this.ready();

  this.onStop(function () {
    Promise.resolve(handle).then((h) => {
      if (typeof h === "function") { h(); } else if (h && typeof h.stop === "function") h.stop();
    }).catch((err) => {
      console.error("Failed to stop contactProfiles contacts observer:", err);
    });
    if (orgHandle) {
      Promise.resolve(orgHandle).then((h) => {
        if (typeof h === "function") { h(); } else if (h && typeof h.stop === "function") h.stop();
      }).catch((err) => {
        console.error("Failed to stop contactProfiles org observer:", err);
      });
    }

    Object.keys(contactAccounts).forEach(function (accountId) {
      removeAccountOfContact(accountId);
    });
  });
});
