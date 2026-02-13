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

import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import { _ } from "meteor/underscore";

import { SandstormDb } from "/imports/sandstorm-db/db";

const ValidHandle = Match.Where(function (handle) {
  check(handle, String);
  return !!handle.match(/^[a-z_][a-z0-9_]*$/);
});

Meteor.methods({
  updateProfile: async function (obsolete, profile) {
    check(profile, {
      name: String,
      handle: ValidHandle,
      pronoun: Match.OneOf("male", "female", "neutral", "robot"),
      unverifiedEmail: Match.Optional(String),
    });

    if (!this.userId) {
      throw new Meteor.Error(403, "not logged in");
    }

    const userToUpdate = Meteor.isServer
        ? await Meteor.users.findOneAsync({ _id: this.userId })
        : Meteor.user();

    const newValues = {
      "profile.name": profile.name,
      "profile.handle": profile.handle,
      "profile.pronoun": profile.pronoun,
    };

    if (Meteor.isServer) {
      await Meteor.users.updateAsync({ _id: userToUpdate._id }, { $set: newValues });
    } else {
      Meteor.users.update({ _id: userToUpdate._id }, { $set: newValues });
    }

    const currentUser = Meteor.isServer
        ? await Meteor.users.findOneAsync({ _id: this.userId })
        : Meteor.user();
    if (!currentUser.hasCompletedSignup) {
      if (Meteor.isServer) {
        await Meteor.users.updateAsync({ _id: this.userId }, { $set: { hasCompletedSignup: true } });
      } else {
        Meteor.users.update({ _id: this.userId }, { $set: { hasCompletedSignup: true } });
      }
    }
  },

  testFirstSignup: async function (profile) {
    if (!this.userId) {
      throw new Meteor.Error(403, "not logged in");
    }

    if (Meteor.isServer) {
      await Meteor.users.updateAsync(this.userId, { $unset: { hasCompletedSignup: "" } });
    } else {
      Meteor.users.update(this.userId, { $unset: { hasCompletedSignup: "" } });
    }
  },

  uploadProfilePicture: async function (obsolete) {
    if (!this.userId) {
      throw new Meteor.Error(403, "not logged in");
    }

    return await this.connection.sandstormDb.newAssetUploadAsync({
      profilePicture: { userId: this.userId },
    });
  },

  cancelUploadProfilePicture: async function (id) {
    check(id, String);
    await this.connection.sandstormDb.fulfillAssetUploadAsync(id);
  },

  setPrimaryEmail: async function (email) {
    check(email, String);
    if (!this.userId) {
      throw new Meteor.Error(403, "Not logged in.");
    }

    const currentUser = Meteor.isServer
        ? await Meteor.users.findOneAsync({ _id: this.userId })
        : Meteor.user();
    const emails = Meteor.isServer
        ? await SandstormDb.getUserEmailsAsync(currentUser)
        : SandstormDb.getUserEmails(currentUser);
    if (!_.findWhere(emails, { email: email, verified: true })) {
      throw new Meteor.Error(403, "Not a verified email of the current user: " + email);
    }

    if (Meteor.isServer) {
      await Meteor.users.updateAsync({ _id: this.userId }, { $set: { primaryEmail: email } });
    } else {
      Meteor.users.update({ _id: this.userId }, { $set: { primaryEmail: email } });
    }
  },
});
