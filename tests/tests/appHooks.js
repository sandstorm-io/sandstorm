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

const {short_wait, medium_wait, long_wait} = require('../utils');
const testappPath = require('path').resolve(__dirname + "/../assets/meteor-testapp.spk");

// TODO: move this out into some shared module, and use it account-settings.js too.
const installMeteorTestApp = (chain) => {
  return chain
    .url('/apps')
    .waitForElementVisible('.upload-button', short_wait)
    .perform(function (client, done) {
      client.setValue("input[type=file]", testappPath, () => {
        done();
      })
    })
    .execute(function () {
      const testappFile = document.querySelector("input[type=file]").files[0];
      uploadApp(testappFile);
    }, [])
    .waitForElementVisible('#confirmInstall', long_wait)
    .click('#confirmInstall')
}

module.exports['Test saving and restoring capabilities via AppHooks'] = function(browser) {
  installMeteorTestApp(
    browser
      .loginDevAccount()
  )
  .waitForElementVisible('button.action', medium_wait)
  .click('button.action')
  // click the "Got it!" button in the "this is your first grain" popup.
  // This shadows the debug log so we have to clear it in order to open the
  // log.
  .waitForElementVisible(".introjs-skipbutton", short_wait)
  .click(".introjs-skipbutton")
  .waitForElementVisible("#openDebugLog", short_wait)
  // We also want to wait a moment before clicking the debug log button, so the
  // first grain popup has actually gotten out of our way:
  .pause(short_wait)
  .click("#openDebugLog")
  .waitForElementVisible('.grain-frame', medium_wait)
  .grainFrame()
  .execute(function() {
    Meteor.call('schedule', 'someObjectId')
  })
  .frameParent()
  .pause(short_wait)
  .execute(function() {
    Meteor.call("runDueJobsAt", Date.now() + 1000 * 60 * 60);
  })
  .pause(short_wait)
  .windowHandles(windows => browser.switchWindow(windows.value[1]))
  .assert.containsText(".grainlog-contents > pre", "Running callback: someObjectId")
}
