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

if (Meteor.isServer) {
  Accounts.validateLoginAttempt(function (attempt) {
    // Enforce expiration times for demo accounts.

    if (attempt.user && attempt.user.expires) {
      if (attempt.user.expires.getTime() < Date.now()) {
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
      var handle = Meteor.setTimeout(function () { connection.close(); }, DEMO_EXPIRATION_MS);
      connection.onClose(function () { Meteor.clearTimeout(handle); });
    }

    return true;
  });

  function cleanupExpiredUsers() {
    // Delete expired demo accounts and all their grains.

    var now = new Date();
    Meteor.users.find({expires: {$lt: now}}, {fields: {_id: 1, lastActive: 1, isAppDemoUser: 1}})
                .forEach(function (user) {
      Grains.find({userId: user._id}, {fields: {_id: 1, lastUsed: 1}})
            .forEach(function (grain) {
        console.log("delete grain: " + grain._id);
        Grains.remove(grain._id);
        if (grain.lastUsed) {
          DeleteStats.insert({type: "grain", lastActive: grain.lastUsed});
        }
        deleteGrain(grain._id);
      });
      console.log("delete user: " + user._id);
      Meteor.users.remove(user._id);
      if (user.lastActive) {
        // When deleting a user, we can specify it as a "normal" user
        // (type: user) or as a user who started out by using the app
        // demo feature (type: appDemoUser).
        var deleteStatsType = "user";
        var isAppDemoUser = !! user.isAppDemoUser;
        if (isAppDemoUser) {
          deleteStatsType = "appDemoUser";
        }
        DeleteStats.insert({type: deleteStatsType, lastActive: user.lastActive});
      }
    });
  }

  Meteor.startup(cleanupExpiredUsers);

  if (allowDemo) {
    Meteor.methods({
      createDemoUser: function (displayName, isAppDemoUser) {
        // This is a login method that creates a new temporary user
        // every time it is used.
        //
        // isAppDemoUser is important for stats; see
        // cleanupExpiredUsers().
        check(displayName, String);

        // Create the new user.
        var expires = new Date(Date.now() + DEMO_EXPIRATION_MS);
        var userId = Accounts.insertUserDoc({ profile: { name: displayName } },
                                            { expires: expires,
                                              isAppDemoUser: !!isAppDemoUser
                                            });

        // Log them in on this connection.
        return Accounts._loginMethod(this, "createDemoUser", arguments,
            "demo", function () { return { userId: userId }; });
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

      var package = packageCursor.fetch()[0];

      // This allows us to avoid creating duplicate UserActions.
      if (this.userId) {
        return [
          packageCursor,
          UserActions.find({userId: this.userId, appId: appId})
        ];
      }

      return packageCursor;
    });

    Meteor.setInterval(cleanupExpiredUsers, DEMO_EXPIRATION_MS);

    // The demo displays some assets loaded from sandstorm.io.
    BrowserPolicy.content.allowOriginForAll("https://sandstorm.io");
  } else {
    // Just run once, in case the config just changed from allowing demos to prohibiting them.
    Meteor.setTimeout(cleanupExpiredUsers, DEMO_EXPIRATION_MS);
  }
}

if (Meteor.isClient && allowDemo) {
  // Monkey-patch accounts-ui so that "demo" shows up nicely.
  // Alas, this is dependent on private Meteor internals and so could break.
  // TODO(cleanup): Check again if there are public APIs we could use and if not, ask for some.
  Meteor.loginWithDemo = function () {
    Router.go("demo");
    Accounts._loginButtonsSession.closeDropdown();
  }
  Accounts.oauth.registerService("demo");
  var oldConfiguredHelper = Template._loginButtonsLoggedOutSingleLoginButton.configured;
  Template._loginButtonsLoggedOutSingleLoginButton.configured = function () {
    if (this.name === "demo") {
      return true;
    } else {
      return oldConfiguredHelper.apply(this, arguments);
    }
  }
  var oldCapitalizedName = Template._loginButtonsLoggedOutSingleLoginButton.capitalizedName;
  Template._loginButtonsLoggedOutSingleLoginButton.capitalizedName = function () {
    if (this.name === "demo") {
      return "Demo User";
    } else {
      return oldCapitalizedName.apply(this, arguments);
    }
  }

  Template.demo.events({
    "click #createDemoUser": function (event) {
      var displayName = document.getElementById("demo-display-name").value.trim();
      if (displayName === "") {
        displayName = "Demo User";
      } else {
        displayName += " (demo)";
      }

      Accounts.callLoginMethod({
        methodName: "createDemoUser",
        methodArguments: [displayName, false],
        userCallback: function (err) {
          if (err) {
            window.alert(err);
          } else {
            Router.go("root");
          }
        }
      });
    }
  });

  Template.appdemo.events({
    "click #createDemoUser": function (event) {
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

      // We copy the appId into the scope so the userCallbackFunction can access it.
      var appId = this.appId;
      var userCallbackFunction = function(err) {
        if (err) {
          window.alert(err);
        } else {
          // First, find the package ID, since that is what
          // addUserActions takes. Choose the package ID with
          // highest version number.
          var packageId = Packages.findOne({appId: appId},
                                           {sort: {"manifest.appVersion": -1}})._id;

          // 3. Install this app for the user, if needed.
          if (UserActions.find({appId: appId, userId: Meteor.userId()}).count() == 0) {
            addUserActions(packageId);
          }

          // 4. Create new grain and 5. browse to it.
          launchAndEnterGrainByPackageId(packageId);
        }
      }

      if (Meteor.userId()) {
        userCallbackFunction();
      } else {
        // 1. Create the Demo User & 2. Log the user in as this Demo User.
        var displayName = document.getElementById("demo-display-name").value.trim();
        if (displayName === "") {
          displayName = "Demo User";
        } else {
          displayName += " (demo)";
        }

        Accounts.callLoginMethod({
          methodName: "createDemoUser",
          methodArguments: [displayName, true],
          userCallback: userCallbackFunction
        });
      }
    }});
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
        // We show the Start the Demo button if you are not logged in.
        shouldShowStartDemo: ! isSignedUpOrDemo(),
        createDemoUserLabel: "Start the demo",
        pageTitle: "Demo",
        isDemoUser: isDemoUser()
      };
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
        var actionTitle = thisPackage.manifest.actions[0].title.defaultText;
        appName = appNameFromActionName(actionTitle);
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
        createDemoUserLabel: "Try " + appName,
        pageTitle: appName + " Demo on Sandstorm",
        appId: this.params.appId,
        isDemoUser: isDemoUser()
      };
    }
  });
});
