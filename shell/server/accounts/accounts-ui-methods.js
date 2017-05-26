// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

// This file contains method definitions which are available on both client and server (on the
// client for prediction purposes, on the server for actual execution).

const ValidHandle = Match.Where(function (handle) {
  check(handle, String);
  return !!handle.match(/^[a-z_][a-z0-9_]*$/);
});

Meteor.methods({
  updateProfile: function (identityId, profile) {
    // TODO(cleanup): This check also appears in sandstorm-db/users.js.
    check(identityId, String);

    check(profile, {
      name: String,
      handle: ValidHandle,
      pronoun: Match.OneOf("male", "female", "neutral", "robot"),
      unverifiedEmail: Match.Optional(String),
    });

    if (!this.userId) {
      throw new Meteor.Error(403, "not logged in");
    }

    const userToUpdate = Meteor.users.findOne({ _id: identityId });

    if (!this.isSimulation &&
        !this.connection.sandstormDb.userHasIdentity(this.userId, identityId)) {
      throw new Meteor.Error(403, "identity is not linked to current user: " + identityId);
    }

    const newValues = {
      "profile.name": profile.name,
      "profile.handle": profile.handle,
      "profile.pronoun": profile.pronoun,
    };

    Meteor.users.update({ _id: userToUpdate._id }, { $set: newValues });

    if (!Meteor.user().hasCompletedSignup) {
      Meteor.users.update({ _id: this.userId }, { $set: { hasCompletedSignup: true } });
    }
  },

  testFirstSignup: function (profile) {
    if (!this.userId) {
      throw new Meteor.Error(403, "not logged in");
    }

    Meteor.users.update(this.userId, { $unset: { hasCompletedSignup: "" } });
  },

  uploadProfilePicture: function (identityId) {
    check(identityId, String);
    if (!this.userId || !this.connection.sandstormDb.userHasIdentity(this.userId, identityId)) {
      throw new Meteor.Error(403, "Not an identity of the current user: " + identityId);
    }

    return this.connection.sandstormDb.newAssetUpload({
      profilePicture: { userId: this.userId, identityId: identityId },
    });
  },

  cancelUploadProfilePicture: function (id) {
    check(id, String);
    this.connection.sandstormDb.fulfillAssetUpload(id);
  },

  setPrimaryEmail: function (email) {
    check(email, String);
    if (!this.userId) {
      throw new Meteor.Error(403, "Not logged in.");
    }

    const emails = SandstormDb.getUserEmails(Meteor.user());
    if (!_.findWhere(emails, { email: email, verified: true })) {
      throw new Meteor.Error(403, "Not a verified email of the current user: " + email);
    }

    Meteor.users.update({ _id: this.userId }, { $set: { primaryEmail: email } });
  },
});
