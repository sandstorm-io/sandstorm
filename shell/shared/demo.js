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

var allowDemo = Meteor.settings && Meteor.settings.public &&
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
    Meteor.users.find({expires: {$lt: now}}, {fields: {_id: 1, lastActive: 1}})
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
        DeleteStats.insert({type: "user", lastActive: user.lastActive});
      }
    });
  }

  Meteor.startup(cleanupExpiredUsers);

  if (allowDemo) {
    Meteor.methods({
      createDemoUser: function (displayName) {
        // This is a login method that creates a new temporary user every time it is used.

        check(displayName, String);

        // Create the new user.
        var expires = new Date(Date.now() + DEMO_EXPIRATION_MS);
        var userId = Accounts.insertUserDoc({ profile: { name: displayName } },
                                            { expires: expires });

        // Log them in on this connection.
        return Accounts._loginMethod(this, "createDemoUser", arguments,
            "demo", function () { return { userId: userId }; });
      }
    });

    Meteor.setInterval(cleanupExpiredUsers, DEMO_EXPIRATION_MS);
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
        methodArguments: [displayName],
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
        isSignedUp: isSignedUpOrDemo(),
        isDemoUser: isDemoUser()
      };
    }
  });
});
