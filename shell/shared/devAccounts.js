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

Accounts.identityServices.dev = {
  isEnabled: function () {
    return allowDevAccounts;
  },
  loginTemplate: {
    name: "devLoginForm",
    priority: -10, // Put it at the top.
  }
}

if (allowDevAccounts) {
  if (Meteor.isServer) {
    var Crypto = Npm.require("crypto");

    Meteor.methods({
      createDevAccount: function (displayName, isAdmin, profile, unverifiedEmail) {
        // This is a login method that creates or logs in a dev account with the given displayName

        check(displayName, String);
        check(isAdmin, Match.OneOf(undefined, null, Boolean));
        check(profile, Match.OneOf(undefined, null, Object));
        check(unverifiedEmail, Match.OneOf(undefined, null, String));

        isAdmin = isAdmin || false;

        profile = profile || {};
        profile.name = profile.name || displayName;
        var hasCompletedSignup = !!unverifiedEmail && !!profile.pronoun && !!profile.handle;

        var user = Meteor.users.findOne({"services.dev.name": displayName});
        var userId;

        if (user) {
          userId = user._id;
        } else {
          userId = Accounts.insertUserDoc({ profile: profile,
                                            unverifiedEmail: unverifiedEmail},
                                          { services:
                                              {dev: {name: displayName,
                                                     isAdmin: isAdmin,
                                                     hasCompletedSignup: hasCompletedSignup}}});
        }
        // Log them in on this connection.
        return Accounts._loginMethod(this, "createDevAccount", arguments,
            "dev", function () { return { userId: userId }; });
      }
    });
  }

  if (Meteor.isClient) {
    loginDevAccount = function(displayName, isAdmin) {
      Accounts.callLoginMethod({
        methodName: "createDevAccount",
        methodArguments: [displayName, isAdmin],
        userCallback: function (err) {
          if (err) {
            window.alert(err);
          }
        }
      });
    };

    loginDevAccountFast = function(displayName, isAdmin) {
      return new Promise(function (resolve, reject) {
        // This skips the firstSignUp page. Mostly used for testing purposes.
        var profile = {
          name: displayName,
          pronoun: "robot",
          handle: "_" + displayName.toLowerCase()
        };

        Accounts.callLoginMethod({
          methodName: "createDevAccount",
          methodArguments: [displayName, isAdmin, profile, displayName + "@example.com"],
          userCallback: function (err) {
            if (err) {
              reject(new Error(err));
            } else {
              Router.go("apps");
              resolve();
            }
          }
        });
      });
    };
  }
}

