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
import { check } from "meteor/check";
import { _ } from "meteor/underscore";

import { send } from "/imports/server/email";
import { SandstormDb } from "/imports/sandstorm-db/db";

async function sendDeletionEmails(db, deletedUserId, byAdminUserId, feedback) {
  const deletedUser = await db.getUserAsync(deletedUserId);

  const userEmail = _.findWhere(await SandstormDb.getUserEmailsAsync(deletedUser), { primary: true });
  const serverTitle = await db.getServerTitleAsync();
  const returnAddress = await db.getReturnAddressAsync();
  if (!byAdminUserId) { // This was initiated by the user, send them an email
    if (!userEmail) {
      console.error("Couldn't send deletion email. No address found for user with userId:",
        deletedUser._id);
    } else {
      const emailOptions = {
        from: returnAddress,
        subject: `Your account on ${serverTitle} will be deleted in 7 days.`,
        text: `You have requested that your Sandstorm account on ${serverTitle} be deleted. Your account has been suspended and will be fully deleted in seven days. If you change your mind, log into ${process.env.ROOT_URL} to cancel the process.

If you did not request this deletion, please contact the server administrator immediately.`,
      };
      try {
        emailOptions.to = userEmail.email;
        await send(emailOptions);
      } catch (err) {
        console.error(
          `Failed to send deletion email to user (id=${deletedUser._id}) with error: ${err}`);
      }
    }
  }

  const deleteUserString = (userEmail && userEmail.email) || ("userId=" + deletedUser._id);
  const emailOptions = {
    from: returnAddress,
    subject: `Account for ${deleteUserString} on ${serverTitle} will be deleted in 7 days`,
  };

  if (byAdminUserId) {
    const initiatingAdmin = await db.getUserAsync(byAdminUserId);
    const adminName = initiatingAdmin.profile.name;
    emailOptions.text = `${adminName} has requested that the Sandstorm account held by ${deleteUserString} on ${serverTitle} be deleted. The account has been suspended and will be fully deleted in seven days. To cancel the deletion, go to: ${process.env.ROOT_URL}/admin/users/${deletedUser._id}`;
  } else {
    emailOptions.text = `${deleteUserString} has requested that their account be deleted on ${serverTitle}. The account has been suspended and will be fully deleted in seven days. To cancel the deletion, go to: ${process.env.ROOT_URL}/admin/users/${deletedUser._id}`;
    if (feedback) {
      emailOptions.text += "\nUser gave the following feedback: " + feedback;
    }
  }

  const admins = await Meteor.users.find({ isAdmin: true }).fetchAsync();
  for (const user of admins) {
    const email = _.findWhere(await SandstormDb.getUserEmailsAsync(user), { primary: true });
    if (!email) {
      console.error("No email found for admin with userId:", user._id);
      continue;
    }

    try {
      emailOptions.to = email.email;
      await send(emailOptions);
    } catch (err) {
      console.error(
        `Failed to send deletion email to admin (id=${user._id}) with error: ${err}`);
    }
  }
}

Meteor.methods({
  async suspendAccount(userId, willDelete) {
    check(userId, String);
    check(willDelete, Boolean);

    if (!await this.connection.sandstormDb.isAdminByIdAsync(this.userId)) {
      throw new Meteor.Error(403, "Only admins can suspend other users.");
    }

    if (userId === Meteor.userId()) {
      throw new Meteor.Error(400, "Admins cannot suspend their own accounts from the admin page. Please go to your account setttings.");
    }

    const db = this.connection.sandstormDb;

    if (Meteor.settings.public.stripePublicKey) {
      await globalThis.BlackrockPayments.suspendAccount(db, userId);
    }

    await db.suspendAccount(userId, Meteor.userId(), willDelete);

    if (willDelete) {
      await sendDeletionEmails(db, userId, Meteor.userId());
    }
  },

  async deleteOwnAccount(feedback) {
    const db = this.connection.sandstormDb;
    if (!Meteor.userId()) {
      throw new Meteor.Error(403, "Must be logged in to delete an account");
    }

    const account = await Meteor.users.findOneAsync({ _id: this.userId });
    if (await db.isUserInOrganizationAsync(account)) {
      throw new Meteor.Error(403, "Users in an organization cannot delete their own account. " +
        "Please ask your admin to do it for you.");
    }

    if (Meteor.settings.public.stripePublicKey) {
      await globalThis.BlackrockPayments.suspendAccount(db, Meteor.userId());
    }

    await db.suspendAccount(Meteor.userId(), null, true);

    await sendDeletionEmails(db, Meteor.userId(), null, feedback);
  },

  async unsuspendAccount(userId) {
    check(userId, String);

    if (!await this.connection.sandstormDb.isAdminByIdAsync(this.userId)) {
      throw new Meteor.Error(403, "Only admins can unsuspend other users.");
    }

    await this.connection.sandstormDb.unsuspendAccount(userId, Meteor.userId());
  },

  async unsuspendOwnAccount() {
    if (!Meteor.userId()) {
      throw new Meteor.Error(403, "Must be logged in to unsuspend an account");
    }

    await this.connection.sandstormDb.unsuspendAccount(Meteor.userId());
  },
});
