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

// This file covers creation and consumption of invite keys (i.e. to invite people to become
// users of the Sandstorm server).

if (Meteor.isServer) {
  Meteor.publish("signupKey", function (key) {
    check(key, String);
    return SignupKeys.find(key);
  });

  Meteor.methods({
    useSignupKey: function (key) {
      check(key, String);

      if (!this.userId) {
        throw new Meteor.Error(403, "Must be signed in.");
      }

      if (isSignedUp()) {
        // Don't waste it.
        return;
      }

      if (isDemoUser()) {
        throw new Meteor.Error(403,
            "Demo users cannot accept invite keys. Please sign in as a real user.");
      }

      var keyInfo = SignupKeys.findOne(key);
      if (!keyInfo || keyInfo.used) {
        throw new Meteor.Error(403, "Invalid key or already used.");
      }

      var userFields = {
        signupKey: key,
        signupNote: keyInfo.note
      };
      if (keyInfo.email) {
        userFields.signupEmail = keyInfo.email;
      }
      if ("quota" in keyInfo) {
        userFields.quota = keyInfo.quota;
      }
      if (keyInfo.plan) {
        userFields.plan = keyInfo.plan;
      }
      if (keyInfo.payments) {
        userFields.payments = keyInfo.payments;
      }

      Meteor.users.update(this.userId, {$set: userFields});
      SignupKeys.update(key, {$set: {used: true}});
    }
  });
}

if (Meteor.isClient) {
  Template.signup.helpers({
    signupDialog: function () {
      var setting = Settings.findOne("signupDialog");
      return (setting && setting.value) || DEFAULT_SIGNUP_DIALOG;
    }
  });
}

Router.map(function () {
  this.route("signup", {
    path: "/signup/:key",

    waitOn: function () {
      return [
        Meteor.subscribe("signupKey", this.params.key),
        Meteor.subscribe("credentials")
      ];
    },

    data: function () {
      var keyInfo = SignupKeys.findOne(this.params.key);

      var result = {
        keyIsValid: !!keyInfo,
        keyIsUsed: keyInfo && keyInfo.used,
        origin: getOrigin(),
        alreadySignedUp: isSignedUp()
      };

      if (result.keyIsValid && !result.keyIsUsed && Meteor.userId()) {
        Meteor.call("useSignupKey", this.params.key);
      }

      return result;
    }
  });
});
