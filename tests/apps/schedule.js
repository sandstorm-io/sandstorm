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

const { short_wait } = require('../utils');

module.exports = {};

function commonSetup(browser, selector) {
  return browser
    .init()
    .loginDevAccount()
    .uploadTestApp()
    .assert.containsText("#grainTitle", "Untitled Sandstorm Test App instance")
    // Start opening this now, so we don't have to wait for it later when we
    // want to use it:
    .click("#openDebugLog")
    .grainFrame()
    .waitForElementPresent(selector, short_wait)
    .click(selector)
}

function switchToLog(chain) {
  return chain.windowHandles(function (windows) {
    chain
      .switchWindow(windows.value[1])
      .waitForElementVisible(".grainlog-contents > pre", short_wait)
  })
}

module.exports["Test periodic tasks"] = function(browser) {
  let chain = commonSetup(browser, "#do-schedule-hourly")
    .frameParent()
    .execute(function() {
      console.log(Meteor.call('advanceTimeMillis', 60 * 60 * 1000))
    })
  switchToLog(chain)
    .pause(short_wait)
    // Make sure the job ran once:
    .assert.containsText(".grainlog-contents > pre", "Running job hourly")
    .windowHandles(windows => chain.switchWindow(windows.value[0]))
    .frameParent()
    .execute(function() {
      Meteor.call('advanceTimeMillis', 60 * 60 * 1000);
    })
    .pause(short_wait)
    .windowHandles(windows => chain.switchWindow(windows.value[1]))
    // Make sure it ran again:
    .assert.containsText(
      ".grainlog-contents > pre",
      "Running job hourly\nRunning job hourly",
    )
}

module.exports["Test canceling tasks"] = function(browser) {
  let chain = commonSetup(browser, "#do-schedule-hourly-cancel")
    .frameParent()
    .execute(function() {
      Meteor.call('advanceTimeMillis', 60 * 60 * 1000);
    })
  switchToLog(chain)
    .pause(short_wait)
    // Make sure the job ran once:
    .assert.containsText(".grainlog-contents > pre", "Running job hourly-cancel")
    .windowHandles(windows => chain.switchWindow(windows.value[0]))
    .frameParent()
    .execute(function() {
      Meteor.call('advanceTimeMillis', 60 * 60 * 1000);
    })
    .windowHandles(windows => chain.switchWindow(windows.value[1]))
    .pause(short_wait)
    // Make sure it didn't run a second time.
    .expect.element(".grainlog-contents > pre").text
    .to.not.contain("Running job hourly-cancel\nRunning job hourly-cancel")
}

module.exports["Test one-shot tasks"] = function(browser) {
  let chain = commonSetup(browser, "#do-schedule-oneshot")
    .pause(short_wait)
    .frameParent()
    .execute(function() {
      Meteor.call('advanceTimeMillis', 5 * 60 * 1000);
    })
  switchToLog(browser)
    .pause(short_wait)
    // Make sure the job ran once:
    .assert.containsText(".grainlog-contents > pre", "Running job oneshot")
    .windowHandles(windows => chain.switchWindow(windows.value[0]))
    .frameParent()
    .execute(function () {
      Meteor.call('advanceTimeMillis', 60 * 60 * 1000);
    })
    .windowHandles(windows => chain.switchWindow(windows.value[1]))
    .pause(short_wait)
    // Make sure it doesn't run a second time.
    .expect.element(".grainlog-contents > pre").text
    .to.not.contain("Running job oneshot\nRunning job oneshot")
}

