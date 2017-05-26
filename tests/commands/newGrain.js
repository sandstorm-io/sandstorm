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

var utils = require("../utils"),
    actionSelector = utils.actionSelector,
    appSelector = utils.appSelector,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

exports.command = function(appId, callback) {
  // Callback is optional and takes a single argument, which will be the ID of the created grain.
  var self = this;
  var ret = self
      .init()
      .url(self.launch_url + "/apps/" + appId)
      .waitForElementVisible(actionSelector, short_wait)
      .click(actionSelector)
      .grainFrame() // wait for the grain frame to exist
      .frame(null)
      .url(function (grainUrl) {
        var regex = new RegExp(self.launch_url + "/grain/([\\w]*)");
        var result = regex.exec(grainUrl.value);
        self.perform(function(client, done) {
          if (typeof callback === "function") {
            callback.call(self, result[1]);
          }
          done();
        });
      });

  return ret;
};
