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

import { send } from "/imports/server/email.js";

function sendDeletionEmails(db, deletedUserId, byAdminUserId) {
  const emailOptions = {
    from: db.getReturnAddress(),
    subject: `${db.getServerTitle()} account deletion initiated`,
    text: "Account will be deleted in 7 days",
  };
  const deletedUser = db.getUser(deletedUserId);
  if (!byAdminUserId) { // This was initiated by the user, send them an email
    const email = _.findWhere(SandstormDb.getUserEmails(deletedUser), { primary: true });
    if (!email) {
      console.error("Couldn't send deletion email. No address found for user with userId:",
        deletedUser._id);
    } else {
      try {
        emailOptions.to = email.email;
        send(emailOptions);
      } catch (err) {
        console.error(
          `Failed to send deletion email to user (id=${user._id}) with error: ${err}`);
      }
    }
  }

  Meteor.users.find({ isAdmin: true }).forEach((user) => {
    if (user._id === byAdminUserId) {
      return; // Skip the admin who initiated the deletion.
    }

    const email = _.findWhere(SandstormDb.getUserEmails(user), { primary: true });
    if (!email) {
      console.error("No email found for admin with userId: ", user._id);
      return;
    }

    try {
      emailOptions.to = email.email;
      send(emailOptions);
    } catch (err) {
      console.error(
        `Failed to send deletion email to admin (id=${user._id}) with error: ${err}`);
    }
  });
}

Meteor.methods({
  suspendAccount(userId, willDelete) {
    check(userId, String);
    check(willDelete, Boolean);

    if (!isAdmin()) {
      throw new Meteor.Error(403, "Only admins can suspend other users.");
    }

    this.connection.sandstormDb.suspendAccount(userId, Meteor.userId(), willDelete);

    if (willDelete) {
      sendDeletionEmails(this.connection.sandstormDb, userId, Meteor.userId());
    }
  },

  deleteOwnAccount() {
    const db = this.connection.sandstormDb;
    if (!Meteor.userId()) {
      throw new Meteor.Error(403, "Must be logged in to delete an account");
    }

    if (db.isUserInOrganization(Meteor.user())) {
      throw new Meteor.Error(403, "Users in an organization cannot delete their own account. " +
        "Please ask your admin to do it for you.");
    }

    db.suspendAccount(Meteor.userId(), null, true);

    sendDeletionEmails(db, Meteor.userId());
  },

  unsuspendAccount(userId) {
    check(userId, String);

    if (!isAdmin()) {
      throw new Meteor.Error(403, "Only admins can unsuspend other users.");
    }

    this.connection.sandstormDb.unsuspendAccount(userId, Meteor.userId());
  },

  unsuspendOwnAccount() {
    if (!Meteor.userId()) {
      throw new Meteor.Error(403, "Must be logged in to unsuspend an account");
    }

    this.connection.sandstormDb.unsuspendAccount(Meteor.userId());
  },
});
