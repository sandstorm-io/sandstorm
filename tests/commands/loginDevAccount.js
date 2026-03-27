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

'use strict';

var crypto = require("crypto");
var utils = require('../utils');

exports.command = function(name, isAdmin, callback) {
  if (!name) {
    name = crypto.randomBytes(10).toString("hex");
  }
  var self = this;
  var ret = this
    .init()
    // loginDevAccountFast is fast, but not 3ms fast, which is ~the default script timeout
    .timeouts("script", 10000)
    .executeAsync(function(name, isAdmin, done) {
      window.loginDevAccountFast(name, isAdmin)
        .then(function () {
          done({ success: true });
        }, function (err) {
          done({ error: err.toString(), stack: err.stack });
        });
    }, [name, isAdmin], function (result) {
      if (result.status !== 0) {
        console.log("executeAsync failed with status:", result.status);
      }
      if (result.value && result.value.error) {
        console.log("Login error:", result.value.error);
      }
      var success = result.status === 0 && result.value && result.value.success;
      self.assert.ok(success, "login completed successfully");
    })
    .url(this.launch_url + "/apps")
    .waitForElementVisible('.app-list', utils.medium_wait)
    .resizeWindow(utils.default_width, utils.default_height)
    .perform(function(client, done) {
      if (typeof callback === "function") {
        callback.call(self, name);
      }
      done();
    });

  this.sandstormAccount = 'dev';
  return ret;
};
