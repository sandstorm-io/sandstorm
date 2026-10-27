// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

"use strict";

var utils = require("../utils");
var grainId = process.env.UPGRADE_GRAIN_ID;
var devName = process.env.UPGRADE_DEV_NAME;
var profileName = process.env.UPGRADE_PROFILE_NAME;

module.exports = {
  "@disabled": !(grainId && devName && profileName),

  "Existing build-308 grain survives the platform upgrade": function (browser) {
    browser
      .loginDevAccount(devName)
      .disableGuidedTour()
      .url(browser.launch_url + "/grain/" + grainId)
      .waitForElementVisible(".grain-frame", utils.medium_wait)
      .grainFrame()
      .waitForElementVisible("#name", utils.medium_wait)
      .assert.textContains("#name", profileName)
      .assert.textContains("#serverRuntime", "classic")
      .frameParent()
      .assert.urlContains("/grain/" + grainId)
      .end();
  },
};
