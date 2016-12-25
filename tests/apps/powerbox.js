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
    actionSelector = utils.actionSelector,
    appSelector = utils.appSelector,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

module.exports = {};

// Source at https://github.com/jparyani/sandstorm-test-app/tree/powerbox
module.exports["Test Powerbox"] = function (browser) {
  browser
    .init()
    .loginDevAccount()
    .installApp("http://sandstorm.io/apps/david/sandstorm-powerbox-test-app4.spk",
                "f855d3c96e18e785a3a734a49919ef18",
                "ygpudg61w49gg0x1t2gw4p7q2q7us24gxsyr1as1hf0ezn2uycth")
    .assert.containsText("#grainTitle", "Untitled PowerboxTest")
    .waitForElementVisible('.grain-frame', short_wait)
    .grainFrame()
    .waitForElementVisible("#offer", short_wait)
    .click("#offer")
    .waitForElementVisible("#offer-result", short_wait)
    .assert.containsText("#offer-result", "offer: success")
    .frameParent()
    .waitForElementVisible("#powerbox-offer-url", short_wait)
    .getText("#powerbox-offer-url", function (result) {
        browser
          .click(".popup.offer .frame button.dismiss")
          .grainFrame()
          .click("#request")
          .frameParent()
          .waitForElementVisible("#powerbox-request-input", short_wait)
          .setValue("#powerbox-request-input", result.value)
          .click("#powerbox-request-form button")
          .grainFrame()
          .waitForElementVisible("#request-result", short_wait)
          .assert.containsText("#request-result", "request: footest");
    });
};


module.exports["Test PowerboxSave"] = function (browser) {
  browser
    browser
    .init()
    .loginDevAccount()
    .installApp("http://sandstorm.io/apps/david/sandstorm-powerbox-test-app4.spk",
                "f855d3c96e18e785a3a734a49919ef18",
                "ygpudg61w49gg0x1t2gw4p7q2q7us24gxsyr1as1hf0ezn2uycth")
    .assert.containsText("#grainTitle", "Untitled PowerboxTest")
    .waitForElementVisible('.grain-frame', short_wait)
    .grainFrame()
    .waitForElementVisible("#offer", short_wait)
    .click("#offer")
    .waitForElementVisible("#offer-result", short_wait)
    .assert.containsText("#offer-result", "offer: success")
    .frameParent()
    .waitForElementVisible("#powerbox-offer-url", short_wait)
    .getText("#powerbox-offer-url", function (result) {
        browser
          .click(".popup.offer .frame button.dismiss")
          .grainFrame()
          .click("#request-save-restore")
          .frameParent()
          .waitForElementVisible("#powerbox-request-input", short_wait)
          .setValue("#powerbox-request-input", result.value)
          .click("#powerbox-request-form button")
          .grainFrame()
          .waitForElementVisible("#request-result", short_wait)
          .assert.containsText("#request-result", "request: footest");
    });
};

// This test adds `requiredPermissions` to the `restore` call that aren't satisfied.
// We test to make sure an error is thrown.
module.exports["Test Powerbox with failing requirements"] = function (browser) {
  browser
    .init()
    .loginDevAccount()
    .installApp("http://sandstorm.io/apps/david/sandstorm-powerbox-test-app4.spk",
                "f855d3c96e18e785a3a734a49919ef18",
                "ygpudg61w49gg0x1t2gw4p7q2q7us24gxsyr1as1hf0ezn2uycth")
    .assert.containsText("#grainTitle", "Untitled PowerboxTest")

    // We'll use the debugLog at the bottom of the test, but it's nice to open it early and give it time to load.
    .click("#openDebugLog")
    .waitForElementVisible('.grain-frame', short_wait)
    .grainFrame()
    .waitForElementVisible("#offer", short_wait)
    .click("#offer")
    .waitForElementVisible("#offer-result", short_wait)
    .assert.containsText("#offer-result", "offer: success")
    .frameParent()
    .waitForElementVisible("#powerbox-offer-url", short_wait)
    .getText("#powerbox-offer-url", function (result) {
       browser
        .click(".popup.offer .frame button.dismiss")
        .grainFrame()
        .click("#request-failing-requirements")
        .frame()
        .waitForElementVisible("#powerbox-request-input", short_wait)
        .setValue("#powerbox-request-input", result.value)
        .click("#powerbox-request-form button")
        .grainFrame()
        .waitForElementVisible("#request-result", short_wait)
        .assert.containsText("#request-result", "request:")
        .windowHandles(function (windows) {
          browser
            .switchWindow(windows.value[1])
            .waitForElementVisible(".grainlog-contents > pre", short_wait)
            .assert.containsText(".grainlog-contents > pre", "Error: Capability revoked because a user involved in introducing it no longer has the necessary permissions")
        });
    })
    .end();
};

module.exports["Test Powerbox embedded request flow"] = function (browser) {
  browser
    .init()
    .loginDevAccount()
    .uploadTestApp()
    .assert.containsText("#grainTitle", "Untitled Sandstorm Test App instance")
    .click("#grainTitle")
    .setAlertText("powerbox-provider")
    .acceptAlert()
    .pause(1000)
    .assert.containsText("#grainTitle", "powerbox-provider")
    .url(function (grainUrl) {
      var grainId = grainUrl.value.split("/").pop();
      var cardSelector = ".powerbox-card button[data-card-id=\"grain-" + grainId + "\"]";
      browser
        .url(browser.launch_url + "/apps")
        .waitForElementVisible(appSelector("6r8gt8ct5e774489grqvzz7dc4fzntpxjrusdwcy329ppnkt3kuh"), short_wait)
        .click(appSelector("6r8gt8ct5e774489grqvzz7dc4fzntpxjrusdwcy329ppnkt3kuh"))
        .waitForElementVisible(actionSelector, short_wait)
        .click(actionSelector)
        .waitForElementVisible("#grainTitle", medium_wait)
        .assert.containsText("#grainTitle", "Untitled Sandstorm Test App instance")
        .click("#grainTitle")
        .setAlertText("powerbox-requester")
        .acceptAlert()
        .pause(1000)
        .assert.containsText("#grainTitle", "powerbox-requester")
        .grainFrame()
        .waitForElementPresent("#do-powerbox-request", medium_wait)
        .click("#do-powerbox-request")
        .frameParent()
        .waitForElementVisible(cardSelector, medium_wait)
        .click(cardSelector)
        .waitForElementVisible(".powerbox-iframe-mount iframe", short_wait)
        .frame("powerbox-grain-frame-" + grainId)
        .waitForElementVisible("#cap-text", medium_wait)
        .setValue("#cap-text", "foo bar baz")
        .click("#do-fulfill")
        .frameParent()
        .grainFrame()
        .waitForElementVisible("#result-text", short_wait)
        .assert.containsText("#result-text", "foo bar baz");
    });
};

module.exports["Test Powerbox query"] = function (browser) {
  browser
    .init()
    .loginDevAccount()

    // Install another app that we can match against. This can be any app other than
    // test-app.spk -- I'm only using the old test app here because it's probably already
    // downloaded.
    .installApp("http://sandstorm.io/apps/david/sandstorm-powerbox-test-app4.spk",
                "f855d3c96e18e785a3a734a49919ef18",
                "ygpudg61w49gg0x1t2gw4p7q2q7us24gxsyr1as1hf0ezn2uycth")
    .url(function (otherGrainUrl) {
      var otherGrainId = otherGrainUrl.value.split("/").pop();

      browser
        .uploadTestApp()
        .url(function (grainUrl) {
          var grainId = grainUrl.value.split("/").pop();

          function tryQuery(buttonId, expectedMatches) {
            browser
                .grainFrame(grainId)
                .waitForElementPresent(buttonId, medium_wait)
                .click(buttonId)
                .frameParent()
                .waitForElementVisible(".popup ul.candidate-cards", short_wait);

            for (var id in expectedMatches) {
              var cardSelector = ".powerbox-card button[data-card-id=\"grain-" + id + "\"]";
              if (expectedMatches[id]) {
                browser.assert.elementPresent(cardSelector);
              } else {
                browser.assert.elementNotPresent(cardSelector);
              }
            }
          }

          tryQuery("#do-powerbox-request", {[grainId]: true, [otherGrainId]: false});
          tryQuery("#do-powerbox-request-no-match", {[grainId]: false, [otherGrainId]: false});
          tryQuery("#do-powerbox-request-wildcard", {[grainId]: true, [otherGrainId]: false});

          // multi-descriptor adds a UiView descriptor into the mix, so our grain of another app
          // will be returned.
          tryQuery("#do-powerbox-request-multi-descriptor", {[grainId]: true, [otherGrainId]: true});
        });
    });
};
