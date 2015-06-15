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

// Here we are testing a toy app (see https://github.com/jparyani/sandstorm-test-app/tree/powerbox
// for the code). It has an "offer" and "request" button that lets us test the basics of the
// copy/paste powerbox flow.

"use strict";

var utils = require("../utils"),
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

module.exports = {};

module.exports["Install Powerbox"] = function (browser) {
  browser
    .init()
    .installApp("http://sandstorm.io/apps/jparyani/powerbox-1.spk", "b0704d58e11f67494b6b203dff5cc8b6")
    .assert.containsText("#grainTitle", "Untitled SandstormTest");
};

module.exports["Test Powerbox"] = function (browser) {
  browser
    .pause(short_wait)
    .frame("grain-frame")
    .waitForElementVisible("#offer", short_wait)
    .click("#offer")
    .waitForElementVisible("#offer-result", short_wait)
    .assert.containsText("#offer-result", "offer: success")
    .frame()
    .waitForElementVisible("#powerbox-offer-popup input", short_wait)
    .getValue("#powerbox-offer-popup input", function (result) {
        browser
          .frame("grain-frame")
          .click("#request")
          .frame()
          .waitForElementVisible("#powerbox-request-input", short_wait)
          .setValue("#powerbox-request-input", result.value)
          .click("#powerbox-request-form button")
          .frame("grain-frame")
          .waitForElementVisible("#request-result", short_wait)
          .assert.containsText("#request-result", "request: footest");
    });
};
