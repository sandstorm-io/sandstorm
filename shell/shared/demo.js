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

allowDemo = Meteor.settings && Meteor.settings.public &&
                Meteor.settings.public.allowDemoAccounts;

var DEMO_EXPIRATION_MS = 60 * 60 * 1000;
var DEMO_GRACE_MS = 10 * 60 * 1000;  // time between expiration and deletion

if (Meteor.isServer) {
  Accounts.validateLoginAttempt(function (attempt) {
    // Enforce expiration times for demo accounts.

    if (attempt.user && attempt.user.expires) {
      var expireIn = attempt.user.expires.getTime() - Date.now() + DEMO_GRACE_MS;
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
      var connection = attempt.connection;
      var handle = Meteor.setTimeout(function () { connection.close(); }, expireIn);
      connection.onClose(function () { Meteor.clearTimeout(handle); });
    }

    return true;
  });

  function cleanupExpiredUsers() {
    // Delete expired demo accounts and all their grains.

    var now = new Date(Date.now() - DEMO_GRACE_MS);
    Meteor.users.find({expires: {$lt: now}},
                      {fields: {_id: 1, loginIdentities: 1, lastActive: 1, isAppDemoUser: 1}})
                .forEach(function (user) {
      Grains.find({userId: user._id}, {fields: {_id: 1, lastUsed: 1, appId: 1}})
            .forEach(function (grain) {
        console.log("delete grain: " + grain._id);
        ApiTokens.remove({grainId: grain._id});
        Grains.remove(grain._id);
        if (grain.lastUsed) {
          DeleteStats.insert({type: "demoGrain", lastActive: grain.lastUsed, appId: grain.appId});
        }
        globalBackend.deleteGrain(grain._id, user._id);
      });
      console.log("delete user: " + user._id);
      // We intentionally do not do `ApiTokens.remove({accountId: user._id})`, because some such
      // tokens might still play an active role in the sharing graph.
      Contacts.remove({ownerId: user._id});
      UserActions.remove({userId: user._id});
      Notifications.remove({userId: user._id});
      Meteor.users.remove(user._id);
      waitPromise(globalBackend.cap().deleteUser(user._id));
      if (user.loginIdentities && user.lastActive) {
        // When deleting a user, we can specify it as a "normal" user
        // (type: user) or as a user who started out by using the app
        // demo feature (type: appDemoUser).
        var deleteStatsType = "demoUser";
        var isAppDemoUser = !! user.isAppDemoUser;
        if (isAppDemoUser) {
          deleteStatsType = "appDemoUser";
        }

        // Intentionally record deleted users at time of deletion to avoid miscounting users that
        // were demoing just before the day rolled over.
        DeleteStats.insert({type: deleteStatsType, lastActive: new Date(), appId: user.appDemoId});
      }
    });
  }

  if (allowDemo) {
    Meteor.methods({
      createDemoUser: function (displayName, isAppDemoUser, appId) {
        // This is a login method that creates a new temporary user
        // every time it is used.
        //
        // isAppDemoUser is important for stats; see
        // cleanupExpiredUsers().
        check(displayName, String);
        check(isAppDemoUser, Boolean);
        check(appId, Match.OneOf(undefined, null, String));

        // Create the new user.
        var expires = new Date(Date.now() + DEMO_EXPIRATION_MS);
        var userId = Accounts.insertUserDoc({ profile: { name: displayName } },
                                            { expires: expires,
                                              isAppDemoUser: isAppDemoUser,
                                              appDemoId: appId
                                            });

        // Log them in on this connection.
        return Accounts._loginMethod(this, "createDemoUser", arguments,
            "demo", function () { return { userId: userId }; });
      },

      testExpireDemo: function () {
        if (!isDemoUser()) throw new Meteor.Error(403, "not a demo user");

        var newExpires = new Date(Date.now() + 15000);
        if (Meteor.user().expires.getTime() < newExpires.getTime()) {
          throw new Meteor.Error(403, "can't exend demo");
        }
        Meteor.users.update(this.userId, {$set: {expires: newExpires}});
      }
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

      var packageCursor = Packages.find(
        {appId: appId},
        {sort: {"manifest.appVersion": -1}});

      var pkg = packageCursor.fetch()[0];

      // This allows us to avoid creating duplicate UserActions.
      if (this.userId) {
        return [
          packageCursor,
          UserActions.find({userId: this.userId, appId: appId})
        ];
      }

      return packageCursor;
    });

    SandstormDb.periodicCleanup(DEMO_EXPIRATION_MS, cleanupExpiredUsers);
  } else {
    // Just run once, in case the config just changed from allowing demos to prohibiting them.
    Meteor.setTimeout(cleanupExpiredUsers, DEMO_EXPIRATION_MS + DEMO_GRACE_MS);
  }
}

if (Meteor.isClient && allowDemo) {
  Meteor.loginWithDemo = function (options, callback) {
    Router.go("demo");
    callback();
  }
  // Note: We intentionally don't register the demo service with Accounts.registerService(); we
  //   don't want it to appear in the sign-in drop-down.

  window.testExpireDemo = function () {
    Meteor.call("testExpireDemo");
  }

  Template.demo.events({
    "click button.start": function (event) {
      var displayName = "Demo User";

      var userCallbackFunction = function (err) {
        if (err) {
          window.alert(err);
        } else {
          Router.go("root");
        }
      }

      if (isSignedUpOrDemo()) {
        userCallbackFunction();
      } else {
        Accounts.callLoginMethod({
          methodName: "createDemoUser",
          methodArguments: ["Demo User", false, null],
          userCallback: userCallbackFunction
        });
      }
    }
  });

  Template.appdemo.events({
    "click button.start": function (event) {
      // When clicking on the createDemoUser button on the app demo,
      // we want to:
      //
      // 1. Create the Demo User if they are not logged in.
      //
      // 2. Log the user in as this Demo User if we created it.
      //
      // 3. Install the chosen app.
      //
      // 4. Create a new grain with this app.
      //
      // 5. Take them into this grain.

      // calculate the appId

      // We copy the appId into the scope so the autorun function can access it.
      var appId = this.appId;
      var signingIn = false;

      // TODO(cleanup): Is there a better way to do this? Before multi-identity, we could use the
      //   `userCallback` option of `Accounts.callLoginMethod()`, but now that doesn't work because
      //   it fires too early.
      //
      // Note that we don't use Template.instance().autorun() because the template gets destroyed
      // and recreated during account creation.
      var done = false;
      var handle = Tracker.autorun(function () {
        if (done) return;

        if (!isSignedUpOrDemo()) {
          if (!signingIn) {
            signingIn = true;
            // 1. Create the Demo User & 2. Log the user in as this Demo User.
            Accounts.callLoginMethod({
              methodName: "createDemoUser",
              methodArguments: ["Demo User", true, appId],
            });
          } else {
            return;
          }
        } else {
          // `handle` may not have been assigned yet if this is the first run of the callback.
          // But we definitely don't want the callback to run again. So we have to resort to
          // setting a flag that disables subsequent runs, and then deferring the actual stop. Ick.
          done = true;
          Meteor.defer(function() { handle.stop(); });

          // First, find the package ID, since that is what
          // addUserActions takes. Choose the package ID with
          // highest version number.
          var packageId = Packages.findOne({appId: appId},
                                           {sort: {"manifest.appVersion": -1}})._id;

          // 3. Install this app for the user, if needed.
          if (UserActions.find({appId: appId, userId: Meteor.userId()}).count() == 0) {
            globalDb.addUserActions(packageId);
          }

          // 4. Create new grain and 5. browse to it.
          launchAndEnterGrainByPackageId(packageId);
        }
      });
    }
  });
}

Router.map(function () {
  this.route("demo", {
    path: "/demo",
    waitOn: function () {
      return Meteor.subscribe("credentials");
    },
    data: function () {
      return {
        allowDemo: allowDemo,
        pageTitle: "Demo",
        isDemoUser: isDemoUser()
      };
    }
  });

  this.route("demoRestart", {
    path: "/demo-restart",
    waitOn: function () {
      return Meteor.subscribe("credentials");
    },
    data: function () {
      Meteor.logout();
      Router.go("demo");
    }
  });
});

Router.map(function () {
  this.route("appdemo", {
    path: "/appdemo/:appId",
    waitOn: function () {
      return Meteor.subscribe("appInfo", this.params.appId);
    },
    data: function () {
      // find the newest (highest version, so "first" when sorting by
      // inverse order) matching package.
      var thisPackage = Packages.findOne({appId: this.params.appId},
                                        {sort: {"manifest.appVersion": -1}});

      // In the case that the app requested is not present, we show
      // this string as the app name.
      var appName = 'missing package';

      if (thisPackage) {
        appName = SandstormDb.appNameFromPackage(thisPackage);
      }

      return {
        allowDemo: allowDemo,
        // For appdemo, we always allow you to start the demo, because
        // the this refers to the app demo, and if a visitor clicks
        // visits /appdemo/:appId once and creates a Demo User
        // account, and then clicks a different /appdemo/:appId URL to
        // demo a different app, we want them to experience the joy of
        // trying the second app.
        shouldShowStartDemo: true,
        appName: appName,
        pageTitle: appName + " Demo on Sandstorm",
        appId: this.params.appId,
        isDemoUser: isDemoUser()
      };
    }
  });
});
