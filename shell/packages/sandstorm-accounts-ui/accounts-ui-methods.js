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

var ValidHandle = Match.Where(function (handle) {
  check(handle, String);
  return !!handle.match(/^[a-z_][a-z0-9_]*$/);
});

Meteor.methods({
  updateProfile: function (profile) {
    // TODO(cleanup): This check also appears in sandstorm-db/users.js.
    check(profile, {
      name: String,
      handle: ValidHandle,
      pronoun: Match.OneOf("male", "female", "neutral", "robot"),
      email: String
    });

    if (!this.userId) {
      throw new Meteor.Error(403, "not logged in");
    }

    Meteor.users.update(this.userId, {$set: {
      "profile.name": profile.name,
      "profile.handle": profile.handle,
      "profile.pronoun": profile.pronoun,
      "profile.email": profile.email,
      "hasCompletedSignup": true
    }});
  },

  testFirstSignup: function (profile) {
    if (!this.userId) {
      throw new Meteor.Error(403, "not logged in");
    }

    Meteor.users.update(this.userId, {$unset: {hasCompletedSignup: ""}});
  }
});

if (Meteor.isClient) {
  window.testFirstSignup = function () {
    Meteor.call("testFirstSignup");
  }
}

if (Meteor.isServer) {
  // Methods that can't be simulated.

  Meteor.methods({
    uploadProfilePicture: function () {
      if (!this.userId) {
        throw new Meteor.Error(403, "Must log in to upload profile picture.");
      }

      return this.connection.sandstormDb.newAssetUpload({
        profilePicture: { userId: this.userId }
      });
    },

    cancelUploadProfilePicture: function (id) {
      check(id, String);
      this.connection.sandstormDb.fulfillAssetUpload(id);
    },
  });
}
