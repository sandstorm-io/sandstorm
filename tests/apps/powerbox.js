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
    .installApp("http://sandstorm.io/apps/jparyani/powerbox-4.spk", "baaceb4cda0d9451968670a3d4ffe5e7", "jm40yaw7zvnxyggqt2dddp5ztt0f5wku7a8wfz8uzn9cjus46ygh")
    .assert.containsText("#grainTitle", "Untitled PowerboxTest");
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
    .waitForElementVisible("#powerbox-offer-url", short_wait)
    .getText("#powerbox-offer-url", function (result) {
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

// Source at https://github.com/jparyani/sandstorm-test-app/tree/powerbox-save
module.exports["Install PowerboxSave"] = function (browser) {
  browser
    .init()
    .installApp("http://sandstorm.io/apps/jparyani/powerbox-save-0.spk", "5af2a3ca2a4e99ff082c458321c85105", "f6pf7a9my5vrcxk22f00msk97zss1ukz5fvesuh2mxfhs8uzvwu0")
    .assert.containsText("#grainTitle", "Untitled PowerboxSaveTest");
};

module.exports["Test PowerboxSave"] = function (browser) {
  browser
    .pause(short_wait)
    .frame("grain-frame")
    .waitForElementVisible("#offer", short_wait)
    .click("#offer")
    .waitForElementVisible("#offer-result", short_wait)
    .assert.containsText("#offer-result", "offer: success")
    .frame()
    .waitForElementVisible("#powerbox-offer-url", short_wait)
    .getText("#powerbox-offer-url", function (result) {
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

// This powerbox app adds `requiredPermissions` to the `restore` call that aren't satisfied.
// We test to make sure an error is thrown.
// Source at https://github.com/jparyani/sandstorm-test-app/tree/powerbox-permissions
module.exports["Install Powerbox with failing requirements"] = function (browser) {
  browser
    .init()
    .installApp("http://sandstorm.io/apps/jparyani/powerbox-2.spk", "9d6493e63bc9919de3959fe0c5a131ad", "jm40yaw7zvnxyggqt2dddp5ztt0f5wku7a8wfz8uzn9cjus46ygh")
    .assert.containsText("#grainTitle", "Untitled PowerboxTest sandstormtest");
};

module.exports["Test Powerbox with failing requirements"] = function (browser) {
  browser
    // We'll use the debugLog at the bottom of the test, but it's nice to open it early and give it time to load.
    .click("#openDebugLog")
    .pause(short_wait)
    .frame("grain-frame")
    .waitForElementVisible("#offer", short_wait)
    .click("#offer")
    .waitForElementVisible("#offer-result", short_wait)
    .assert.containsText("#offer-result", "offer: success")
    .frame()
    .waitForElementVisible("#powerbox-offer-url", short_wait)
    .getText("#powerbox-offer-url", function (result) {
        browser
          .frame("grain-frame")
          .click("#request")
          .frame()
          .waitForElementVisible("#powerbox-request-input", short_wait)
          .setValue("#powerbox-request-input", result.value)
          .click("#powerbox-request-form button")
          .frame("grain-frame")
          .waitForElementVisible("#request-result", short_wait)
          .assert.containsText("#request-result", "request:")
          .windowHandles(function (windows) {
            browser
              .switchWindow(windows.value[1])
              .waitForElementVisible(".grainlog-contents > pre", short_wait)
              .assert.containsText(".grainlog-contents > pre", "Error: Requirements not satisfied")
          });
    });
};

// This test revokes a permission of a live powerbox cap, and expects an error to occur.
// Source at https://github.com/jparyani/sandstorm-test-app/tree/powerbox-membrane
module.exports["Test Powerbox membrane"] = function (browser) {
  var firstUserName;
  var secondUserName;
  var grainUrl;
  browser
    .init()
    .installApp("http://sandstorm.io/apps/jparyani/powerbox-membrane-0.spk", "7a555b1fc63d7fbb07109c8cf8fd9ed3", "10p6jj3zzkh5v9ymmcmjaj8cj2yqx29j1g1vku7nt71pt1c28cmh")
    .assert.containsText("#grainTitle", "Untitled PowerboxMembraneTest")
    .execute(function () { return Meteor.user().identities[0].service.dev.name; }, [], function(result) {
      firstUserName = result.value;
    })
    .url(function (url) {
      grainUrl = url.value;
    })
    .click('.topbar .share > .show-popup')
    .waitForElementVisible("#shareable-link-tab-header", short_wait)
    .click("#shareable-link-tab-header")
    .waitForElementVisible(".new-share-token", short_wait)
    .submitForm('.new-share-token')
    .waitForElementVisible('#share-token-text', medium_wait)
    // Navigate to the url with 2nd user
    .getText('#share-token-text', function(response) {
      browser
        .loginDevAccount()
        .execute(function () { return Meteor.user().identities[0].service.dev.name; }, [], function(result) {
          secondUserName = result.value;
        })
        .url(response.value)
        .waitForElementVisible(".redeem-token-button", short_wait)
        .click(".redeem-token-button")
        .waitForElementVisible('#grainTitle', medium_wait)
        .pause(short_wait)
        .frame("grain-frame")
        .waitForElementVisible("#offer", short_wait)
        .click("#offer")
        .waitForElementVisible("#offer-result", short_wait)
        .assert.containsText("#offer-result", "offer: success")
        .frame()
        .waitForElementVisible("#powerbox-offer-url", short_wait)
        .getText("#powerbox-offer-url", function (result) {
            browser
              .frame("grain-frame")
              .click("#request")
              .frame()
              .waitForElementVisible("#powerbox-request-input", short_wait)
              .setValue("#powerbox-request-input", result.value)
              .click("#powerbox-request-form button")
              .frame("grain-frame")
              .waitForElementVisible("#request-result", short_wait)
              .assert.containsText("#request-result", "request: footest")
              .click("#test")
              .waitForElementVisible("#testInterface-result", short_wait)
              .assert.containsText("#testInterface-result", "testInterface: footest")
              .loginDevAccount(firstUserName)
              .url(grainUrl)
              .waitForElementVisible("#grainTitle", short_wait)
              .click('.topbar .share > .show-popup')
              .waitForElementVisible(".who-has-access", short_wait)
              .click(".who-has-access")
              .waitForElementVisible('.popup.who-has-access', short_wait)
              .waitForElementVisible(".popup.who-has-access .share-token-role", short_wait)
              .pause(short_wait)
              .setValue(".popup.who-has-access .share-token-role", "can read")
              .pause(short_wait)
              .loginDevAccount(secondUserName)
              .url(grainUrl)
              .pause(short_wait)
              .frame('grain-frame')
              .click("#test")
              .waitForElementVisible("#testInterface-result", short_wait)
              .assert.containsText("#testInterface-result", "testInterface: couldn't call testInterface");
        });
    });
};
