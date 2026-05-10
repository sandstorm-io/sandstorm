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

"use strict";

var crypto = require("crypto");
var utils = require("../utils");

exports.command = function (name, isAdmin, callback) {
  if (!name) {
    name = crypto.randomBytes(10).toString("hex");
  }

  var loginName = isAdmin ? "Alice Dev Admin" : name;
  var self = this;

  var ret = this
    .init()
    .captureBrowserExceptions(function (event) {
      utils.logBrowserException("loginDevAccount", event);
    })
    .frame(null)
    .url(this.launch_url + "/")
    .timeouts("script", 10000)
    .executeAsync(function (displayName, admin, done) {
      var deadline = Date.now() + 9000;

      function waitFor(description, getValue, callback) {
        var value = getValue();
        if (value) {
          callback(value);
          return;
        }

        if (Date.now() > deadline) {
          done({ success: false, error: "timed out waiting for " + description });
          return;
        }

        setTimeout(function () {
          waitFor(description, getValue, callback);
        }, 25);
      }

      function getLoginApi() {
        var accountsPkg = window.Package && window.Package["accounts-base"];
        var AccountsObj = accountsPkg && accountsPkg.Accounts;
        var meteorPkg = window.Package && window.Package.meteor;
        var MeteorObj = meteorPkg && meteorPkg.Meteor;

        if (AccountsObj && typeof AccountsObj.callLoginMethod === "function" &&
            MeteorObj && typeof MeteorObj.userId === "function") {
          return { Accounts: AccountsObj, Meteor: MeteorObj };
        }

        return null;
      }

      waitFor("Meteor login API", getLoginApi, function (api) {
        var profile = {
          name: displayName,
          pronoun: "robot",
          handle: "_" + displayName.toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
        };

        api.Accounts.callLoginMethod({
          methodName: "createDevAccount",
          methodArguments: [displayName, !!admin, profile, displayName + "@example.com"],
          userCallback: function (err) {
            if (err) {
              done({ success: false, error: err.reason || err.message || String(err) });
              return;
            }

            waitFor("userId after createDevAccount", function () {
              return api.Meteor.userId();
            }, function () {
              done({ success: true });
            });
          },
        });
      });
    }, [loginName, !!isAdmin], function (result) {
      var ok = result.status === 0 && result.value && result.value.success;
      if (!ok && result.value && result.value.error) {
        console.log("Login error:", result.value.error);
      }
      self.assert.ok(ok, "login completed successfully");
    })
    .url(this.launch_url + "/apps")
    .waitForElementVisible(".app-list", utils.medium_wait)
    .resizeWindow(utils.default_width, utils.default_height)
    .perform(function (client, done) {
      if (typeof callback === "function") {
        callback.call(self, loginName);
      }
      done();
    });

  this.sandstormAccount = "dev";
  return ret;
};
