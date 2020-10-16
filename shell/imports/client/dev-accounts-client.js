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

import { Accounts } from "meteor/accounts-base";
import { Router } from "meteor/iron:router";

loginDevAccount = function (displayName, isAdmin, callback) {
  Accounts.callLoginMethod({
    methodName: "createDevAccount",
    methodArguments: [displayName, isAdmin],
    userCallback(err) {
      if (callback) {
        callback(err);
      } else if (err) {
        window.alert(err);
      }
    },
  });
};

loginDevAccountFast = function (displayName, isAdmin) {
  return new Promise(function (resolve, reject) {
    // This skips the firstSignUp page. Mostly used for testing purposes.
    const profile = {
      name: displayName,
      pronoun: "robot",
      handle: "_" + displayName.toLowerCase(),
    };

    Accounts.callLoginMethod({
      methodName: "createDevAccount",
      methodArguments: [displayName, isAdmin, profile, displayName + "@example.com"],
      userCallback(err) {
        if (err) {
          reject(new Error(err));
        } else {
          Router.go("apps");
          resolve();
        }
      },
    });
  });
};

