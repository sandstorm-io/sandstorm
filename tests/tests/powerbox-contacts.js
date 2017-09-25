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

// Tests powerbox requests for `Identity` capabilities.
// The app's source code is hosted at https://github.com/sandstorm-io/sandstorm-test-python.

var crypto = require("crypto");
var utils = require("../utils"),
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

var APP_ID = "umeqc9yhncg63fjj6sahtw30nf99kfm6tgkuz8rmhn5dqtusnwah";

module.exports = {};

module.exports["Test powerbox request contact"] = function (browser) {
  // We need to prepend 'A' so that the default handle is always valid.
  var aliceName = "A" + crypto.randomBytes(10).toString("hex");
  var bobName = "A" + crypto.randomBytes(10).toString("hex");

  browser
    .loginDevAccount(aliceName)
    .installApp("http://sandstorm.io/apps/david/sandstorm-test-python7.spk",
                "b06dc34b21ba3e8dcedc6d8bab351eac",
                APP_ID)
    .assert.containsText("#grainTitle", "Untitled Test App test page")
    .waitForElementVisible('.grain-frame', short_wait)

    // First we need to make sure that Bob is in Alice's contacts
    .executeAsync(function (done) {
      var grainId = Grains.findOne()._id;
      Meteor.call("newApiToken", { accountId: Meteor.userId() },
                  grainId, "petname", { allAccess: null },
                  { webkey: { forSharing: true }, },
                  function(error, result) {
                    Meteor.logout();
                    done({ error: error, result: result, });
                    });
      }, [], function (result) {
        browser.assert.equal(!result.value.error, true)
        browser
          .loginDevAccount(bobName)
          .url(browser.launch_url + "/shared/" + result.value.result.token)
          .waitForElementVisible("button.reveal-identity-button", short_wait)
          .click("button.reveal-identity-button")
          .waitForElementVisible('.grain-frame', medium_wait)
          .executeAsync(function (done) {
            done(Meteor.userId());
          }, [], function (result) {
            var bobAccountId = result.value;
            var powerboxCardSelector =
                ".popup.request .candidate-cards .powerbox-card " +
                "button[data-card-id=frontendref-identity-" + bobAccountId + "]";
            browser.execute("window.Meteor.logout()")
              // OK, now create a new grain and share it to Bob through the powerbox.
              .loginDevAccount(aliceName)
              .disableGuidedTour(function () {
                browser.newGrain(APP_ID, function(grainId) {
                  browser
                    .waitForElementVisible("#grainTitle", short_wait)
                    .assert.containsText("#grainTitle", "Untitled Test App test page")
                    .grainFrame()
                    .waitForElementVisible("#powerbox-request-identity", short_wait)
                    .click("#powerbox-request-identity")
                    .frameParent()
                    .waitForElementVisible(powerboxCardSelector, short_wait)
                    .click(powerboxCardSelector)

                    .waitForElementVisible(".popup.request .selected-card>form button.connect-button",
                                           short_wait)
                    .click(".popup.request .selected-card>form button.connect-button")
                    .grainFrame()
                    .waitForElementVisible("span.token", short_wait)
                    .waitForElementVisible("form.test-identity button", short_wait)
                    .click("form.test-identity button")
                    .waitForElementVisible("form.test-identity div.result", short_wait)
                    .assert.containsText("form.test-identity div.result", bobName)

                    // Now trash the grain as Bob.
                    .frame()
                    .execute("window.Meteor.logout()")
                    .loginDevAccount(bobName)
                    .url(browser.launch_url + "/grain")
                    .waitForElementVisible(".grain-list-table .select-all-grains>input", short_wait)
                    .click(".grain-list-table .select-all-grains>input")
                    .click(".bulk-action-buttons button.move-to-trash")

                    // Now check that the grain can no longer restore the Identity capability.
                    .execute("window.Meteor.logout()")
                    .loginDevAccount(aliceName)
                    .url(browser.launch_url + "/grain/" + grainId)
                    .waitForElementVisible("#grainTitle", short_wait)
                    .assert.containsText("#grainTitle", "Untitled Test App test page")
                    .grainFrame()
                    .waitForElementVisible("span.token", short_wait)
                    .waitForElementVisible("form.test-identity button", short_wait)
                    .click("form.test-identity button")
                    .waitForElementVisible("form.test-identity div.result", short_wait)
                    .assert.containsText("form.test-identity div.result",
                                         "failed to fetch profile")
                    .end()
                });
              });
          });
      });
};
