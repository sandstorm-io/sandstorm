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

// Here we are testing a toy app (see https://github.com/jparyani/sandstorm-test-app for the code).
// All it does is call stayAwake, and then either leak it's wakelock forever, or wait 15s and delete
// it. The first 2 tests below are the "leak forever" version, and the next 2 tests are for the
// "wait 15s" version.

"use strict";

var utils = require("../utils"),
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

module.exports = {};

module.exports["Install"] = function (browser) {
  browser
    .init()
    .loginDevAccount()
    .installApp("http://sandstorm.io/apps/jparyani/background-test-0.spk", "dbed78d1ef5ed4a4f8193e829672623e", "duvq9t519fdcpetkk2s1axe1hdy91zc5svhzas2yfqpn8df9cd40")
    .assert.containsText("#grainTitle", "Untitled SandstormTest");
};

module.exports["Test Notification"] = function (browser) {
  browser
    // We'll use the debugLog at the bottom of the test, but it's nice to open it early and give it time to load.
    .click("#openDebugLog")
    .waitForElementVisible(".topbar .notifications .count", short_wait)
    .assert.containsText(".topbar .notifications .count", "1")
    .click(".topbar .notifications>.show-popup")
    .waitForElementNotPresent(".topbar .notifications .count", short_wait)
    .click(".cancel-notification")
    .pause(short_wait)
    .windowHandles(function (windows) {
      browser
        .switchWindow(windows.value[1])
        .waitForElementVisible(".grainlog-contents > pre", short_wait)
        .assert.containsText(".grainlog-contents > pre", "Grain has enabled backgrounding")
        .assert.containsText(".grainlog-contents > pre", "Grain's backgrounding has been disabled")
        .closeWindow()
        .end();
    });
};

module.exports["Install Wakelock Dropper"] = function (browser) {
  browser
    .init()
    .loginDevAccount()
    .installApp("http://sandstorm.io/apps/jparyani/background-test-drop-wakelock-1.spk", "963745fa41d602dfc7467cac2e1597b5", "duvq9t519fdcpetkk2s1axe1hdy91zc5svhzas2yfqpn8df9cd40")
    .assert.containsText("#grainTitle", "Untitled SandstormTest");
};

module.exports["Test Notification Wakelock Dropper"] = function (browser) {
  browser
    // We'll use the debugLog at the bottom of the test, but it's nice to open it early and give it time to load.
    .click("#openDebugLog")
    .waitForElementVisible(".topbar .notifications .count", short_wait)
    .assert.containsText(".topbar .notifications .count", "1")
    .pause(short_wait)
    .windowHandles(function (windows) {
      browser
        .switchWindow(windows.value[1])
        .waitForElementVisible(".grainlog-contents > pre", short_wait)
        .assert.containsText(".grainlog-contents > pre", "Grain has enabled backgrounding")
        .pause(18000) // After 15 seconds, the app will drop its wakelock
        .assert.containsText(".grainlog-contents > pre", "Grain's backgrounding has been disabled")
        .closeWindow()
        .end();
    });
};
