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

Meteor.methods({
  suspendAccount(userId, willDelete) {
    check(userId, String);
    check(willDelete, Boolean);

    if (!isAdmin()) {
      throw new Meteor.Error(403, "Only admins can suspend other users.");
    }

    this.connection.sandstormDb.suspendAccount(userId, Meteor.userId(), willDelete);
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
