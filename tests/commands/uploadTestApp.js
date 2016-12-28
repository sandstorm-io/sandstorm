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

var utils = require("../utils"),
    actionSelector = utils.actionSelector,
    appSelector = utils.appSelector,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

exports.command = function(dontStartGrain, callback) {
  var browser = this;
  var ret = browser
    .init()
    .url(this.launch_url + "/upload-test")
    .waitForElementVisible("#upload-app", short_wait)
    .setValue("#upload-app", process.env.SANDSTORM_TESTAPP_PATH)
    .waitForElementVisible("#step-confirm", long_wait)
    .click("#confirmInstall")
    .url(this.launch_url + "/apps")
    .waitForElementVisible(".app-list", medium_wait)
    .resizeWindow(utils.default_width, utils.default_height);

  if (!dontStartGrain) {
    ret = ret
      // The introjs overlay often doesn't destroy itself fast enough and intercepts
      // clicks that we don't want it to intercept. So we manually disable it here.
      .disableGuidedTour()
      .click(appSelector("6r8gt8ct5e774489grqvzz7dc4fzntpxjrusdwcy329ppnkt3kuh"))
      .waitForElementVisible(actionSelector, short_wait)
      .click(actionSelector)
      .waitForElementVisible("#grainTitle", medium_wait);
  }

  if (typeof callback === "function") {
    return ret.status(callback);
  } else {
    return ret;
  }
};
