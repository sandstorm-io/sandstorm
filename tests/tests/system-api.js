// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2020 Sandstorm Development Group, Inc. and contributors
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

const { short_wait } = require('../utils');

module.exports = {};

module.exports["Test system api"] = function(browser) {
  const selector = "#do-test-system-api";
  browser
    .init()
    .loginDevAccount()
    .uploadTestApp()
    .assert.textContains("#grainTitle", "Untitled Sandstorm Test App instance")
    // Start opening this now, so we don't have to wait for it later when we
    // want to use it:
    .click("#openDebugLog")
    .grainFrame()
    .waitForElementPresent(selector, short_wait)
    .click(selector)
    .pause(short_wait)
    .windowHandles(windows => browser.switchWindow(windows.value[1]))
    .waitForElementVisible(".grainlog-contents > pre", short_wait)
    .assert.textContains(".grainlog-contents > pre", "testSystemApi() passed.")

  // Close the grain log, and switch back to to the main window, to avoid
  // confusing future tests:
  browser.windowHandles(windows => {
    browser.closeWindow()
    browser.switchWindow(windows.value[0])
  })
}
