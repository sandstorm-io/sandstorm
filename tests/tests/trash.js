// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

var crypto = require("crypto");
var utils = require("../utils"),
    very_short_wait = utils.very_short_wait,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;
var expectedHackerCMSGrainTitle = "Untitled Hacker CMS site";
var expectedGitWebGrainTitle = "Untitled GitWeb repository";
var hackerCmsAppId = "nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh";

module.exports["Test grain trash"] = function (browser) {
  var firstUserName;
  var grainUrl;
  var grainId;
  var grainCheckboxSelector;

  browser
    .loginDevAccount()
    .installApp("http://sandstorm.io/apps/ssjekyll8.spk", "ca690ad886bf920026f8b876c19539c1",
                hackerCmsAppId)
    .getDevName(function (result) {
      firstUserName = result.value;
    })
    .waitForElementVisible('.grain-frame', medium_wait)
    .url(function (urlResponse) {
      grainUrl = urlResponse.value;
      grainId = grainUrl.split("/").pop();
      grainCheckboxSelector = ".grain-list td.select-grain input[data-grainid='" + grainId + "']";
    })
    .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
    .waitForElementVisible('.topbar .share > .show-popup', short_wait)
    .click('.topbar .share > .show-popup')
    .waitForElementVisible("#shareable-link-tab-header", short_wait)
    .click("#shareable-link-tab-header")
    .waitForElementVisible(".new-share-token", short_wait)
    .submitForm('.new-share-token')
    .waitForElementVisible('#share-token-text', medium_wait)

    .getText('#share-token-text', function(tokenResponse) {
      browser
        .loginDevAccount(null, false, function (secondUserName) {
          browser
            .disableGuidedTour()
            .url(tokenResponse.value)
            .waitForElementVisible("button.reveal-identity-button", short_wait)
            .click("button.reveal-identity-button")
            .waitForElementVisible('.grain-frame', medium_wait)
            .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
            .grainFrame()
            .waitForElementPresent('#publish', medium_wait)
            .assert.containsText('#publish', 'Publish')
            .frame(null)

            .waitForElementVisible(".navitem-open-grain>a", short_wait)
            .click(".navitem-open-grain>a")
            .waitForElementVisible(grainCheckboxSelector, medium_wait)
            .click(grainCheckboxSelector)
            .click(".bulk-action-buttons button.move-to-trash")
            .click("button.show-trash")
            .waitForElementVisible(grainCheckboxSelector, short_wait)
            .click("button.show-main-list")
            .waitForElementVisible("button.show-trash", short_wait)
            .assert.elementNotPresent(grainCheckboxSelector)
            .click(".navbar-grains>li[data-grainid='" + grainId + "']")
            .waitForElementVisible(".grain-interstitial", short_wait)
            .assert.containsText(".grain-interstitial>p", "This grain is in your trash.")
            .click("button.restore-from-trash")
            .waitForElementVisible('.grain-frame', medium_wait)
            .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
            .grainFrame()
            .waitForElementPresent('#publish', medium_wait)
            .assert.containsText('#publish', 'Publish')
            .frame(null)

            .loginDevAccount(firstUserName)
            .disableGuidedTour()
            .url(grainUrl)
            .waitForElementVisible(".navitem-open-grain>a", short_wait)
            .click(".navitem-open-grain>a")
            .waitForElementVisible(grainCheckboxSelector, medium_wait)
            .click(grainCheckboxSelector)
            .click(".bulk-action-buttons button.move-to-trash")
            .pause(very_short_wait)
            .click("button.show-trash")
            .waitForElementVisible(grainCheckboxSelector, short_wait)
            .click("button.show-main-list")
            .waitForElementVisible("button.show-trash", short_wait)
            .assert.elementNotPresent(grainCheckboxSelector)
            .click(".navbar-grains>li[data-grainid='" + grainId + "']")
            .waitForElementVisible(".grain-interstitial", short_wait)
            .assert.containsText(".grain-interstitial>p", "This grain is in your trash.")

            .loginDevAccount(secondUserName)
            .disableGuidedTour()
            .url(grainUrl)
            .waitForElementVisible(".grain-interstitial", short_wait)
            .assert.containsText(".grain-interstitial>p",
                                 "You can no longer access this grain because its owner has moved it to the trash.")

            .click(".navitem-open-grain>a")
            .waitForElementVisible(grainCheckboxSelector, short_wait)
            .click(grainCheckboxSelector)
            .click(".bulk-action-buttons button.move-to-trash")
            .click("button.show-trash")
            .waitForElementVisible(grainCheckboxSelector, medium_wait)
            .click(grainCheckboxSelector)
            .click(".bulk-action-buttons button.remove-permanently")
            .click("button.show-main-list")
            .waitForElementVisible("button.show-trash", short_wait)
            .assert.elementNotPresent(grainCheckboxSelector)
            .click("button.show-trash")
            .waitForElementVisible("button.show-main-list", short_wait)
            .assert.elementNotPresent(grainCheckboxSelector)

            .loginDevAccount(firstUserName)
            .disableGuidedTour()
            .waitForElementVisible(".navitem-open-grain>a", short_wait)
            .click(".navitem-open-grain>a")
            .waitForElementVisible("button.show-trash", medium_wait)
            .click("button.show-trash")
            .waitForElementVisible(grainCheckboxSelector, medium_wait)
            .click(grainCheckboxSelector)
            .click(".bulk-action-buttons button.remove-permanently")
            .click("button.show-main-list")
            .waitForElementVisible("button.show-trash", short_wait)
            .assert.elementNotPresent(grainCheckboxSelector)
            .click("button.show-trash")
            .waitForElementVisible("button.show-main-list", short_wait)
            .assert.elementNotPresent(grainCheckboxSelector)
            .end()
        });
    });
}

module.exports["Test topbar trash button"] = function (browser) {
  // We need to prepend 'A' so that the default handle is always valid.
  var devName1 = "A" + crypto.randomBytes(10).toString("hex");
  var devName2 = "A" + crypto.randomBytes(10).toString("hex");

  browser
    .loginDevAccount(devName2)
    .executeAsync(function (done) {
      done(Meteor.userId());
    }, [], function (result) {
      var devAccountId2 = result.value;
      browser.execute("window.Meteor.logout()")
      browser
        .loginDevAccount(devName1)
        .installApp("http://sandstorm.io/apps/ssjekyll8.spk", "ca690ad886bf920026f8b876c19539c1",
                    hackerCmsAppId)
        .waitForElementVisible("#grainTitle", medium_wait)
        .assert.containsText("#grainTitle", expectedHackerCMSGrainTitle)

        .url(function (urlResponse) {
          var grainUrl = urlResponse.value;
          var grainId = grainUrl.split("/").pop();
          var grainCheckboxSelector =
              ".grain-list td.select-grain input[data-grainid='" + grainId + "']";
          browser.executeAsync(function (grainId, devAccountId2, done) {
            Meteor.call("newApiToken", { accountId: Meteor.userId() },
                        grainId, "petname", { allAccess: null },
                        { user: { accountId: devAccountId2, title: "title 1", } },
                        function(error, result) {
                          Meteor.logout();
                          done({ error: error, result: result, });
                        });
          }, [grainId, devAccountId2], function (result) {
            browser.assert.equal(!result.value.error, true);
            browser
              .loginDevAccount(devName2)
              .url(browser.launch_url + "/shared/" + result.value.result.token)
              .waitForElementVisible('.grain-frame', medium_wait)
              .waitForElementVisible("#deleteGrain", medium_wait)
              .click("#deleteGrain")
              .acceptAlert()
              .waitForElementVisible("button.show-trash", medium_wait)
              .click("button.show-trash")
              .waitForElementVisible(grainCheckboxSelector, medium_wait)
              .url(grainUrl)
              .waitForElementVisible(".grain-interstitial", short_wait)
              .assert.containsText(".grain-interstitial>p", "This grain is in your trash.")
              .assert.elementNotPresent("#deleteGrain")

              .execute("window.Meteor.logout()")

              .loginDevAccount(devName1)
              .executeAsync(function (grainId, devAccountId2, done) {
                Meteor.call("newApiToken", { accountId: Meteor.userId() },
                            grainId, "petname", { allAccess: null },
                            { user: { accountId: devAccountId2, title: "title 2", } },
                            function(error, result) {
                              Meteor.logout();
                              done({ error: error, result: result, });
                            });
              }, [grainId, devAccountId2], function (result) {
                browser.assert.equal(!result.value.error, true)
                browser
                  .loginDevAccount(devName2)
                  .url(browser.launch_url + "/shared/" + result.value.result.token)
                  .waitForElementVisible('.grain-frame', medium_wait)
                  .waitForElementVisible("#grainTitle", medium_wait)
                  .waitForElementVisible("#deleteGrain", short_wait)
                  .end();
              });
          });
        });
    });
}
