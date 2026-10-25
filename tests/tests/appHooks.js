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

const { medium_wait, long_wait } = require("../utils");

function callMeteor(browser, method, args) {
  return browser.executeAsync(function (method, args, done) {
    const meteor = window.Package.meteor.Meteor;
    meteor.call(method, ...args, function (error) {
      done(error ? { error: error.message } : { ok: true });
    });
  }, [method, args], function (result) {
    browser.assert.deepEqual(result.value, { ok: true }, method + " completed successfully");
  });
}

module.exports["Test saving and restoring capabilities via AppHooks"] = function (browser) {
  const objectId = "apphooks-persistent-callback";

  browser
    .loginDevAccount()
    .disableGuidedTour()
    .timeouts("script", long_wait)
    .uploadMeteorTestApp()
    .waitForElementVisible("button.action", medium_wait)
    .click("button.action")
    .grainFrame()
    // This response proves the fixture's DDP connection is ready.
    .waitForElementVisible("#serverRuntime", medium_wait)
    .assert.textContains("#serverRuntime", "serverRuntime: " +
        (process.env.EXPECTED_SERVER_RUNTIME === undefined ? "classic" :
          process.env.EXPECTED_SERVER_RUNTIME))
    .perform(function () {
      callMeteor(browser, "schedule", [objectId]);
    })
    .frame(null)
    .url(function (result) {
      const grainUrl = result.value;
      const grainId = new URL(grainUrl).pathname.split("/")[2];
      // Remove the grain iframe before shutdown so DDP cannot restart it.
      browser.click(".navbar-grains>li[data-grainid='" + grainId + "']>button.close-button")
        .waitForElementNotPresent("#grain-frame-" + grainId, medium_wait)
        .url(browser.launch_url + "/apps")
        .waitForElementVisible(".upload-button", medium_wait);
      callMeteor(browser, "shutdownGrain", [grainId]);
      callMeteor(browser, "runDueJobsAt", [Date.now() + 2 * 60 * 60 * 1000]);
      browser.url(grainUrl)
        .waitForElementVisible("#openDebugLog", medium_wait)
        .openDebugLog();
    })
    .windowHandles(function (windows) {
      browser.switchWindow(windows.value[1])
        .waitForElementVisible(".grainlog-contents > pre", medium_wait)
        .executeAsync(function (objectId, timeout, done) {
          const deadline = Date.now() + timeout;
          function check() {
            const text = document.querySelector(".grainlog-contents > pre").textContent;
            const saved = text.indexOf("saving: " + objectId);
            const restored = text.indexOf("restoring: " + objectId, saved + 1);
            const ran = text.indexOf("Running callback: " + objectId, restored + 1);
            if (saved !== -1 && restored > saved && ran > restored) {
              done({ ok: true });
            } else if (Date.now() >= deadline) {
              done({ error: text });
            } else {
              setTimeout(check, 100);
            }
          }
          check();
        }, [objectId, medium_wait], function (result) {
          browser.assert.deepEqual(result.value, { ok: true },
              "Callback was saved, restored after shutdown, and run through AppHooks");
        })
        .closeWindow()
        .switchWindow(windows.value[0]);
    })
    .end();
};
