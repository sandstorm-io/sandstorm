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

const { short_wait, run_xfail } = require('../utils');

module.exports = {};

function waitForLogLine(browser, text, timeout) {
  return browser.executeAsync(function (needle, maxWait, done) {
    var start = Date.now();
    (function check() {
      var pre = document.querySelector(".grainlog-contents > pre");
      var content = pre && (pre.innerText || pre.textContent) || "";
      if (content.indexOf(needle) !== -1) {
        done({ ok: true });
        return;
      }

      if (Date.now() - start > maxWait) {
        done({ ok: false, content: content });
        return;
      }

      setTimeout(check, 100);
    })();
  }, [text, timeout], function (result) {
    browser.assert.equal(result.value && result.value.ok, true,
        "Timed out waiting for debug log line: " + text);
  });
}

// The tests in this file all follow a similar form, implemented by this function:
//
// 1. Schedule the job, by clicking on a given button in the test app.
// 2. Wait until the job is due to run (really, call runDueJobsAt()).
// 3. Check the debug log to verify that the job ran.
// 4. Wait some more.
// 5. Check if it ran again.
//
// The parameter is an object with properties:
//
// - browser: the browser context
// - refStr: the refStr identifying which job type to schedule (hourly, oneshot...).
// - firstWaitDuration: how long the first wait should be (the second is always an
//   hour).
// - shouldRepeat: whether we should expect the task to run a second time. The test
//   passes only if the observed behavior agrees with this.
function common({browser, refStr, firstWaitDuration, shouldRepeat}) {
  const selector = "#do-schedule-" + refStr;
  const now = Date.now();
  const firstCheck = now + firstWaitDuration;
  const secondCheck = firstCheck + (60 * 60 * 1000); // 1 hr
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
    .waitForElementVisible("#sched-response", short_wait)
    .assert.textContains("#sched-response", "Success: true")
    .frameParent()
    .execute('Meteor.call("runDueJobsAt", ' + firstCheck.toString() + ');')
    .windowHandles(windows => browser.switchWindow(windows.value[1]))
    .waitForElementVisible(".grainlog-contents > pre", short_wait);

  waitForLogLine(browser, "Running job " + refStr, short_wait);

  browser
    .windowHandles(windows => browser.switchWindow(windows.value[0]))
    .frameParent()
    .execute('Meteor.call("runDueJobsAt", ' + secondCheck.toString() + ');')
    .windowHandles(windows => browser.switchWindow(windows.value[1]));

  waitForLogLine(browser, "Running job " + refStr + "\nRunning job " + refStr, short_wait);
  let chain = browser.expect.element(".grainlog-contents > pre").text;
  if(!shouldRepeat) {
    chain = chain.not
  }
  chain.contain(
    "Running job " + refStr + "\nRunning job " + refStr
  )
  // Close the grain log, and switch back to to the main window, to avoid
  // confusing future tests:
  browser.windowHandles(windows => {
    browser.closeWindow()
    browser.switchWindow(windows.value[0])
  })
}

if (run_xfail) {
  // https://github.com/sandstorm-io/sandstorm/issues/3295
  module.exports["Test periodic tasks"] = function(browser) {
    common({
      browser,
      refStr: 'hourly',
      firstWaitDuration: 60 * 60 * 1000,
      shouldRepeat: true,
    })
  }

  module.exports["Test canceling tasks"] = function(browser) {
    common({
      browser,
      refStr: 'hourly-cancel',
      firstWaitDuration: 60 * 60 * 1000,
      shouldRepeat: false,
    })
  }

  module.exports["Test one-shot tasks"] = function(browser) {
    common({
      browser,
      refStr: 'oneshot',
      firstWaitDuration: 5 * 60 * 1000,
      shouldRepeat: false,
    })
  }
}
