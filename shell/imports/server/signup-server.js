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

import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { globalDb } from "/imports/db-deprecated.js";

Meteor.publish("signupKey", function (key) {
  check(key, String);
  return globalDb.collections.signupKeys.find(key);
});

Meteor.methods({
  useSignupKey: function (key) {
    check(key, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be signed in.");
    }

    const user = Meteor.user();
    if (user.signupKey) {
      // Don't waste it.
      return;
    }

    if (isDemoUser()) {
      throw new Meteor.Error(403,
          "Demo users cannot accept invite keys. Please sign in as a real user.");
    }

    if (!user.loginCredentials) {
      // Don't consume signup key as identity user.
      return;
    }

    const keyInfo = globalDb.collections.signupKeys.findOne(key);
    if (!keyInfo || keyInfo.used) {
      throw new Meteor.Error(403, "Invalid key or already used.");
    }

    if (isSignedUp() && user.payments && user.payments.id) {
      // This user is already signed up with a payment account. Possibly, they signed up before
      // using their invite, and then went back and clicked on the invite. As a result they
      // probably now have two payment accounts. Mark this invite as used but also add a special
      // flag so we can find it later and cancel the dupe payment account. Record who tried to
      // use it so that we can transfer credits over if needed.
      globalDb.collections.signupKeys.update(key, { $set: { used: true, rejectedBy: this.userId } });
      return;
    }

    const userFields = {
      signupKey: key,
      signupNote: keyInfo.note,
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
      userFields["payments.id"] = keyInfo.payments.id;
    }

    Meteor.users.update(this.userId, { $set: userFields });
    globalDb.collections.signupKeys.update(key, { $set: { used: true } });
  },
});
