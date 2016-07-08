// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

import { allowDemo } from "/imports/demo.js";

const DEMO_EXPIRATION_MS = 60 * 60 * 1000;
const DEMO_GRACE_MS = 10 * 60 * 1000;  // time between expiration and deletion

Accounts.validateLoginAttempt(function (attempt) {
  // Enforce expiration times for demo accounts.

  if (attempt.user && attempt.user.expires) {
    const expireIn = attempt.user.expires.getTime() - Date.now() + DEMO_GRACE_MS;
    if (expireIn < 0) {
      throw new Meteor.Error(403, "This demo account has expired.");
    }

    if (!allowDemo) {
      // An expiration time implies that this is a demo account, but those have been disabled.
      // Perhaps the config was just changed.
      throw new Meteor.Error(403, "Demo accounts have been disabled.");
    }

    // Force connection close when account expires, so that the client reconnects and
    // re-authenticates, which fails.
    const connection = attempt.connection;
    const handle = Meteor.setTimeout(function () { connection.close(); }, expireIn);

    connection.onClose(function () { Meteor.clearTimeout(handle); });
  }

  return true;
});

function cleanupExpiredUsers() {
  // Delete expired demo accounts and all their grains.

  const now = new Date(Date.now() - DEMO_GRACE_MS);
  Meteor.users.find({ expires: { $lt: now } },
                    { fields: { _id: 1, loginIdentities: 1, lastActive: 1, appDemoId: 1 } })
              .forEach(function (user) {

    globalDb.deleteGrains({ userId: user._id }, globalBackend, "demoGrain");

    console.log("delete user: " + user._id);
    // We intentionally do not do `ApiTokens.remove({accountId: user._id})`, because some such
    // tokens might still play an active role in the sharing graph.
    Contacts.remove({ ownerId: user._id });
    UserActions.remove({ userId: user._id });
    Notifications.remove({ userId: user._id });
    Meteor.users.remove(user._id);
    waitPromise(globalBackend.cap().deleteUser(user._id));
    if (user.loginIdentities && user.lastActive) {
      // When deleting a user, we can specify it as a "normal" user
      // (type: user) or as a user who started out by using the app
      // demo feature (type: appDemoUser).
      let deleteStatsType = "demoUser";
      const isAppDemoUser = !!user.appDemoId;
      if (isAppDemoUser) {
        deleteStatsType = "appDemoUser";
      }

      // Intentionally record deleted users at time of deletion to avoid miscounting users that
      // were demoing just before the day rolled over.
      DeleteStats.insert({ type: deleteStatsType, lastActive: new Date(), appId: user.appDemoId });
    }
  });
}

if (allowDemo) {
  Meteor.methods({
    createDemoUser: function (displayName, appDemoId) {
      // This is a login method that creates a new temporary user
      // every time it is used.
      //
      // appDemoId is important for stats; see cleanupExpiredUsers().
      check(displayName, String);
      check(appDemoId, Match.OneOf(undefined, null, String));

      // Create the new user.
      const newUser = { expires: new Date(Date.now() + DEMO_EXPIRATION_MS) };
      if (appDemoId) {
        newUser.appDemoId = appDemoId;
      }

      const userId = Accounts.insertUserDoc({ profile: { name: displayName } }, newUser);

      // Log them in on this connection.
      return Accounts._loginMethod(this, "createDemoUser", arguments,
          "demo", function () { return { userId: userId }; });
    },

    testExpireDemo: function () {
      if (!isDemoUser()) throw new Meteor.Error(403, "not a demo user");

      const newExpires = new Date(Date.now() + 15000);
      if (Meteor.user().expires.getTime() < newExpires.getTime()) {
        throw new Meteor.Error(403, "can't exend demo");
      }

      Meteor.users.update(this.userId, { $set: { expires: newExpires } });
    },
  });

  // If demo mode is enabled, we permit the client to subscribe to
  // information about an app by appId. If this were available in
  // non-demo mode, then anonymous users could effectively ask the
  // server which apps are installed.
  Meteor.publish("appInfo", function (appId) {
    // This publishes info about an app, including the latest
    // version of it. Once you log in, it also publishes your
    // list of UserActions.
    check(appId, String);

    const packageCursor = Packages.find(
      { appId: appId },
      { sort: { "manifest.appVersion": -1 } });

    const pkg = packageCursor.fetch()[0];

    // This allows us to avoid creating duplicate UserActions.
    if (this.userId) {
      return [
        packageCursor,
        UserActions.find({ userId: this.userId, appId: appId }),
      ];
    }

    return packageCursor;
  });

  SandstormDb.periodicCleanup(DEMO_EXPIRATION_MS, cleanupExpiredUsers);
} else {
  // Just run once, in case the config just changed from allowing demos to prohibiting them.
  Meteor.setTimeout(cleanupExpiredUsers, DEMO_EXPIRATION_MS + DEMO_GRACE_MS);
}

