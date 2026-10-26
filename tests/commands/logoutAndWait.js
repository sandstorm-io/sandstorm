// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

exports.command = function () {
  var browser = this;
  return browser.executeAsync(function (done) {
    var meteorPkg = window.Package && window.Package.meteor;
    var MeteorObj = meteorPkg && meteorPkg.Meteor;
    if (!MeteorObj || typeof MeteorObj.logout !== "function") {
      done({ success: false, error: "Meteor.logout unavailable" });
      return;
    }

    MeteorObj.logout(function (err) {
      if (err) {
        done({ success: false, error: err.reason || err.message || String(err) });
        return;
      }

      var start = Date.now();
      (function waitForLogoutCommit() {
        var userId = typeof MeteorObj.userId === "function" ? MeteorObj.userId() : null;
        if (!userId) {
          done({ success: true });
          return;
        }

        if (Date.now() - start > 5000) {
          done({ success: false, error: "timed out waiting for Meteor.userId() to clear" });
          return;
        }

        setTimeout(waitForLogoutCommit, 25);
      })();
    });
  }, [], function (result) {
    var ok = result.status === 0 && result.value && result.value.success;
    if (!ok && result.value && result.value.error) {
      console.log("Logout error:", result.value.error);
    }
    browser.assert.ok(ok, "logout completed successfully");
  });
};
