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
  const deletedUser = db.getUser(deletedUserId);

  const userEmail = _.findWhere(SandstormDb.getUserEmails(deletedUser), { primary: true });
  if (!byAdminUserId) { // This was initiated by the user, send them an email
    if (!userEmail) {
      console.error("Couldn't send deletion email. No address found for user with userId:",
        deletedUser._id);
    } else {
      const emailOptions = {
        from: db.getReturnAddress(),
        subject: `Your account on ${db.getServerTitle()} will be deleted in 7 days.`,
        text: `You have requested that your Sandstorm account on ${db.getServerTitle()} be deleted. Your account has been suspended and will be fully deleted in seven days. If you change your mind, log into ${process.env.ROOT_URL} to cancel the process.

If you did not request this deletion, please contact the server administrator immediately.`,
      };
      try {
        emailOptions.to = userEmail.email;
        send(emailOptions);
      } catch (err) {
        console.error(
          `Failed to send deletion email to user (id=${deletedUser._id}) with error: ${err}`);
      }
    }
  }

  const deleteUserString = (userEmail && userEmail.email) || ("userId=" + deletedUser._id);
  const emailOptions = {
    from: db.getReturnAddress(),
    subject: `Account for ${deleteUserString} on ${db.getServerTitle()} will be deleted in 7 days`,
  };

  if (byAdminUserId) {
    const initiatingAdmin = db.getUser(byAdminUserId);
    const adminName = db.getIdentity(initiatingAdmin.loginIdentities[0].id).profile.name;
    emailOptions.text = `${adminName} has requested that the Sandstorm account held by ${deleteUserString} on ${db.getServerTitle()} be deleted. The account has been suspended and will be fully deleted in seven days. To cancel the deletion, go to: ${process.env.ROOT_URL}/admin/users`;
  } else {
    emailOptions.text = `${deleteUserString} has requested that their acccount be deleted on ${db.getServerTitle()}. The account has been suspended and will be fully deleted in seven days. To cancel the deletion, go to: ${process.env.ROOT_URL}/admin/users`;
  }

  Meteor.users.find({ isAdmin: true }).forEach((user) => {
    if (user._id === byAdminUserId) {
      return; // Skip the admin who initiated the deletion.
    }

    const email = _.findWhere(SandstormDb.getUserEmails(user), { primary: true });
    if (!email) {
      console.error("No email found for admin with userId:", user._id);
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

    if (userId === Meteor.userId()) {
      throw new Meteor.Error(400, "Admins cannot suspend their own accounts from the admin page. Please go to your account setttings.");
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
