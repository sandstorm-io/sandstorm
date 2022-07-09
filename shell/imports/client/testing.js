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

import { Meteor } from "meteor/meteor";
import { isTesting } from "/imports/shared/testing";

function mockLoginGithub() {
  Meteor.call("createMockGithubUser", function (err) {
    if (err) {
      console.log(err);
    }

    window.localStorage.setItem("Meteor.loginToken", "F0S6luPxIJV--y_GAkBKOMuWMYnnqgG3UMv9M-DIs2f");
    window.localStorage.setItem("Meteor.loginTokenExpires", "Mon Nov 10 2099 21:16:02 GMT-0800 (PST)");
    window.localStorage.setItem("Meteor.userId", "Py8fwsaryQNGBuiXb");
    window.location.reload();
  });
}

function clearMockGithubUser() {
  Meteor.call("clearMockGithubUser", function (err) {
    if (err) {
      console.log(err);
    }
  });
}

function mockLoginGoogle() {
  Meteor.call("createMockGoogleUser", function (err) {
    if (err) {
      console.log(err);
    }

    window.localStorage.setItem("Meteor.loginToken", "P3ffUfVJtptyVX2IPUfNDZY0F3b-GIZ-WQf7w3GdL21");
    window.localStorage.setItem("Meteor.loginTokenExpires", "Tue Nov 18 2099 23:52:55 GMT-0800 (PST)");
    window.localStorage.setItem("Meteor.userId", "6WJcRo2gg2Ysuxsok");
    window.location.reload();
  });
}

function clearMockGoogleUser() {
  Meteor.call("clearMockGoogleUser", function (err) {
    if (err) {
      console.log(err);
    }
  });
}

// The tests rely on these being in global scope, since they are called by code
// that is injected into the page, so we can't do es6 exports for them. Let's
// at least namespace them.
//
// There are no doubt other functions in the codebase that need to be called
// from global scope in the tests. As we discover them, we should give them
// similar treatment. Eventually, all of our code will use explicit imports
// and exports, and there will be a single global assignment like this
// through which the tests will access the functionality they need.
if(isTesting) {
  window.testLoginHelpers = {
    mockLoginGithub,
    clearMockGithubUser,
    mockLoginGoogle,
    clearMockGoogleUser,
  }
}
