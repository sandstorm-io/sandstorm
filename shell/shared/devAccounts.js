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

var allowDevAccounts = Meteor.settings && Meteor.settings.public &&
                 Meteor.settings.public.allowDevAccounts;

if (allowDevAccounts) {
  if (Meteor.isServer) {
    Meteor.methods({
      createDevAccount: function (displayName, isAdmin) {
        // This is a login method that creates or logs in a dev account with the given displayName

        check(displayName, String);
        isAdmin = isAdmin || false;
        var userId;
        var user = Meteor.users.findOne({devName: displayName});
        if (user) {
          userId = user._id;
        } else {
          userId = Accounts.insertUserDoc({ profile: { name: displayName } },
                                          { signupKey: "devAccounts", devName: displayName, isAdmin: isAdmin });
        }
        // Log them in on this connection.
        return Accounts._loginMethod(this, "createDevAccount", arguments,
            "devAccounts", function () { return { userId: userId }; });
      }
    });
  }

  if (Meteor.isClient) {
    Meteor.loginWithDevAccounts = function () {
      Router.go("devAccounts");
      Accounts._loginButtonsSession.closeDropdown();
    };
    Accounts.ui.registerService("devAccounts", "a Dev Account");

    var loginDevAccount = function(displayName, isAdmin) {
      Accounts.callLoginMethod({
        methodName: "createDevAccount",
        methodArguments: [displayName, isAdmin],
        userCallback: function (err) {
          if (err) {
            window.alert(err);
          } else {
            Router.go("root");
          }
        }
      });
    };
    Template.devAccounts.events({
      "click #loginAliceDevAccount": function (event) {
        var displayName = "Alice Dev Admin";
        loginDevAccount(displayName, true);
      },
      "click #loginBobDevAccount": function (event) {
        var displayName = "Bob Dev User";
        loginDevAccount(displayName);
      },
      "click #loginCarolDevAccount": function (event) {
        var displayName = "Carol Dev User";
        loginDevAccount(displayName);
      },
      "click #loginDaveDevAccount": function (event) {
        var displayName = "Dave Dev User";
        loginDevAccount(displayName);
      },
      "click #loginEveDevAccount": function (event) {
        var displayName = "Eve Dev User";
        loginDevAccount(displayName);
      },
    });
  }

  Router.map(function () {
    this.route("devAccounts", {
      path: "/devAccounts",
      waitOn: function () {
        return Meteor.subscribe("credentials");
      },
      data: function () {
        return {
          allowDevAccounts: allowDevAccounts,
          // We show the Start the Demo button if you are not logged in.
          shouldShowStartDevAccounts: ! isSignedUpOrDemo(),
          createLocalUserLabel: "Start the devAccounts",
          pageTitle: "Developer Accounts",
          isDemoUser: isDemoUser()
        };
      }
    });
  });
}

