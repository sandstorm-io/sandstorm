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
import { globalDb } from "/imports/db-deprecated.js";
import { SandstormAutoupdateApps } from "/imports/sandstorm-autoupdate-apps/autoupdate-apps.js";

const isTesting = Meteor.settings && Meteor.settings.public &&
                  Meteor.settings.public.isTesting;

// jscs:disable requireCamelCaseOrUpperCaseIdentifiers
if (isTesting) {
  if (Meteor.isServer) {
    import { runDueJobs } from '/imports/server/scheduled-job.js';

    function clearUser(id) {
      globalDb.collections.userActions.remove({ userId: id });
      globalDb.removeApiTokens({ userId: id });
      globalDb.collections.grains.find({ userId: id }).forEach(function (grain) {
        globalBackend.deleteGrain(grain._id);
      });

      globalDb.collections.grains.remove({ userId: id });
      Meteor.users.remove({ _id: id });
    }

    Meteor.methods({
      runDueJobsAt(whenMillis) {
        runDueJobs(new Date(whenMillis))
      },

      createMockGithubUser: function () {
        Meteor.users.update({ _id: "Py8fwsaryQNGBuiXb" },
                            { $set: { createdAt: new Date("2014-08-11T21:44:04.147Z"), isAdmin: true, lastActive: new Date("2014-08-19T09:58:39.676Z"), profile: { name: "Github User" }, services: { github: { accessToken: "sometoken", id: 1595880, username: "testuser" }, resume: { loginTokens: [{ when: new Date("2099-08-13T05:16:02.356Z"),     hashedToken: "GriUSDp+uN/K4HptwSl1wsdWfHEpS8c9KjjdqwKNo0k=" }] } }, signupKey: "admin" } },
                            { upsert: true });
      },

      clearMockGithubUser: function () {
        clearUser("Py8fwsaryQNGBuiXb");
      },

      createMockGoogleUser: function () {
        Meteor.users.update({ _id: "6WJcRo2gg2Ysuxsok" },
                            { $set: { createdAt: new Date("2014-08-21T07:52:55.581Z"), profile: { name: "Google User" }, services: { google: { accessToken: "sometoken", expiresAt: 4562182723000, id: "116893057283177439912", verified_email: true, name: "Google User", given_name: "Google", family_name: "User", picture: "https://lh3.googleusercontent.com/-XdUIqdMkCWA/AAAAAAAAAAI/AAAAAAAAAAA/4252rscbv5M/photo.jpg", locale: "en", gender: "male" }, resume: { loginTokens: [{ when: new Date("2099-08-21T07:52:55.592Z"),   hashedToken: "cbJGxLGKW3f0j7Ehit77hdK58W7xuPjzZhGHgKhyddo=" }] } }, signupKey: "admin" } },
                           { upsert: true });
      },

      clearMockGoogleUser: function () {
        clearUser("6WJcRo2gg2Ysuxsok");
      },

      fetchAppIndexTest: function () {
        globalDb.collections.appIndex.remove({});
        SandstormAutoupdateApps.updateAppIndex(this.connection.sandstormDb);
      },
    });
  } else {
    // The tests rely on these being in global scope, since they are called by code
    // that is injected into the page, so we can't do es6 exports for them. Let's
    // at least namespace them.
    //
    // There are no doubt other functions in the codebase that need to be called
    // from global scope in the tests. As we discover them, we should give them
    // similar treatment. Eventually, all of our code will use explicit imports
    // and exports, and there will be a single global assignment like this
    // through which the tests will access the functionality they need.
    window.testLoginHelpers = {
      mockLoginGithub() {
        Meteor.call("createMockGithubUser", function (err) {
          if (err) {
            console.log(err);
          }

          window.localStorage.setItem("Meteor.loginToken", "F0S6luPxIJV--y_GAkBKOMuWMYnnqgG3UMv9M-DIs2f");
          window.localStorage.setItem("Meteor.loginTokenExpires", "Mon Nov 10 2099 21:16:02 GMT-0800 (PST)");
          window.localStorage.setItem("Meteor.userId", "Py8fwsaryQNGBuiXb");
          window.location.reload();
        });
      },

      clearMockGithubUser() {
        Meteor.call("clearMockGithubUser", function (err) {
          if (err) {
            console.log(err);
          }
        });
      },

      mockLoginGoogle() {
        Meteor.call("createMockGoogleUser", function (err) {
          if (err) {
            console.log(err);
          }

          window.localStorage.setItem("Meteor.loginToken", "P3ffUfVJtptyVX2IPUfNDZY0F3b-GIZ-WQf7w3GdL21");
          window.localStorage.setItem("Meteor.loginTokenExpires", "Tue Nov 18 2099 23:52:55 GMT-0800 (PST)");
          window.localStorage.setItem("Meteor.userId", "6WJcRo2gg2Ysuxsok");
          window.location.reload();
        });
      },

      clearMockGoogleUser() {
        Meteor.call("clearMockGoogleUser", function (err) {
          if (err) {
            console.log(err);
          }
        });
      },
    }
  }
}
