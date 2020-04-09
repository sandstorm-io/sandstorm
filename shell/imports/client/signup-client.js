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

// This file covers the client side of the invite key workflow.

import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { DEFAULT_SIGNUP_DIALOG } from "/imports/client/personalization.js";

Template.signup.helpers({
  signupDialog: function () {
    const setting = Settings.findOne("signupDialog");
    return (setting && setting.value) || DEFAULT_SIGNUP_DIALOG;
  },
});

Router.map(function () {
  this.route("signup", {
    path: "/signup/:key",

    waitOn: function () {
      return [
        Meteor.subscribe("signupKey", this.params.key),
        Meteor.subscribe("credentials"),
      ];
    },

    data: function () {
      const keyInfo = SignupKeys.findOne(this.params.key);
      const user = Meteor.user();

      const result = {
        keyIsValid: !!keyInfo,
        keyIsUsed: keyInfo && keyInfo.used,
        origin: getOrigin(),
        alreadySignedUp: (user && !!user.signupKey) ||
                         (keyInfo && user && keyInfo.rejectedBy === user._id),
        hasPaymentInfo: keyInfo && !!keyInfo.payments,
      };

      if (result.keyIsValid && !result.keyIsUsed && Meteor.userId()) {
        Meteor.call("useSignupKey", this.params.key);
      }

      return result;
    },
  });
});
