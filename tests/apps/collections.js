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
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait;

var COLLECTIONS_APP_ID = "s3u2xgmqwznz2n3apf30sm3gw1d85y029enw5pymx734cnk5n78h";
var COLLECTIONS_PACKAGE_ID = "f636f1239d9bd0eace4de2f7e238b633";
var COLLECTIONS_PACKAGE_URL = "https://sandstorm.io/apps/david/collections1.spk";

module.exports = {};

function setGrainTitle(browser, collectionTitle) {
  return browser
    .waitForElementVisible("#grainTitle", short_wait)
    .click("#grainTitle")
    .setAlertText(collectionTitle)
    .acceptAlert()
    .grainFrame()
    .waitForElementVisible("button[title='add description']", short_wait)
    .click("button[title='add description']")
    .waitForElementVisible("form.description-row>textarea", short_wait)
    .setValue("form.description-row>textarea", "This is " + collectionTitle)
    .click("form.description-row>button")
    .frame(null)
}

function powerboxCardSelector(grainId) {
  return ".popup.request .candidate-cards .powerbox-card button[data-card-id=grain-" + grainId + "]";
}

module.exports["Test Collections"] = function (browser) {
  // Prepend 'A' so that the default handle is valid.
  var devNameAlice = "A" + crypto.randomBytes(10).toString("hex");
  var devNameBob = "A" + crypto.randomBytes(10).toString("hex");
  var devNameCarol = "A" + crypto.randomBytes(10).toString("hex");
  var devIdentityAlice = crypto.createHash("sha256").update("dev:" + devNameAlice).digest("hex");
  var devIdentityBob = crypto.createHash("sha256").update("dev:" + devNameBob).digest("hex");
  var devIdentityCarol = crypto.createHash("sha256").update("dev:" + devNameCarol).digest("hex");

  browser = browser
    .init()
    .loginDevAccount(devNameAlice)
    .installApp(COLLECTIONS_PACKAGE_URL, COLLECTIONS_PACKAGE_ID, COLLECTIONS_APP_ID);
  browser = setGrainTitle(browser, "Collection A");

  browser.executeAsync(function (bobIdentityId, done) {
    // Share Collection A to Bob.
    var grainId = Grains.findOne()._id;
    Meteor.call("newApiToken", { identityId: Meteor.user().loginIdentities[0].id },
                grainId, "petname", { allAccess: null },
                { user: { identityId: bobIdentityId, title: "Collection A", } },
                function(error, result) {
                  done({ error: error, grainId: grainId, });
                });
  }, [devIdentityBob], function (result) {
    var grainIdA = result.value.grainId;
    browser.assert.equal(!result.value.error, true);
    browser.newGrain(COLLECTIONS_APP_ID, function (grainIdB) {
      browser = setGrainTitle(browser, "Collection B");

      browser.newGrain(COLLECTIONS_APP_ID, function (grainIdC) {
        browser = setGrainTitle(browser, "Collection C");

        browser = browser
          .url(browser.launch_url + "/grain/" + grainIdA)
          .grainFrame()
          .waitForElementVisible("table.grain-list-table>tbody>tr.add-grain>td>button", medium_wait)
          .click("table.grain-list-table>tbody>tr.add-grain>td>button")
          .frame(null)
          .waitForElementVisible(powerboxCardSelector(grainIdB), short_wait)
          .click(powerboxCardSelector(grainIdB))
          // Add with 'editor' permissions.
          .waitForElementVisible(".popup.request .selected-card>form input[value='0']", short_wait)
          .click(".popup.request .selected-card>form input[value='0']")
          .click(".popup.request .selected-card>form button.connect-button")

          .grainFrame()
          .waitForElementVisible("table.grain-list-table>tbody>tr.add-grain>td>button", short_wait)
          .click("table.grain-list-table>tbody>tr.add-grain>td>button")
          .frame(null)
          .waitForElementVisible(powerboxCardSelector(grainIdC), short_wait)
          .click(powerboxCardSelector(grainIdC))
          // Add with 'viewer' permissions.
          .waitForElementVisible(".popup.request .selected-card>form input[value='1']", short_wait)
          .click(".popup.request .selected-card>form input[value='1']")
          .click(".popup.request .selected-card>form button.connect-button")

          .grainFrame()
          .waitForElementVisible("table.grain-list-table>tbody tr:nth-child(3).grain", short_wait)
          .click("table.grain-list-table>tbody tr:nth-child(3).grain .click-to-go")
          .frame(null)

          .grainFrame(grainIdC)
          .waitForElementVisible(".description-row p", short_wait)
          .assert.containsText(".description-row p", "This is Collection C")
          .waitForElementVisible(".description-row button.description-button", short_wait)
          .frame(null)

          .execute("window.Meteor.logout()")

          // Log in as Bob
          .loginDevAccount(devNameBob)
          .url(browser.launch_url + "/grain/" + grainIdA)
          .grainFrame()
          .waitForElementVisible(".description-row p", short_wait)
          .assert.containsText(".description-row p", "This is Collection A")
          .waitForElementVisible(".description-row button.description-button", short_wait)

          .waitForElementVisible("table.grain-list-table>tbody>tr.add-grain>td>button", short_wait)
          .waitForElementVisible("table.grain-list-table>tbody tr:nth-child(2).grain", short_wait)
          .assert.containsText("table.grain-list-table>tbody tr:nth-child(2).grain td>a",
                               "Collection B")
          .click("table.grain-list-table>tbody tr:nth-child(2).grain .click-to-go")
          .frame(null)

          .grainFrame(grainIdB)
          .waitForElementVisible(".description-row p", short_wait)
          .assert.containsText(".description-row p", "This is Collection B")
          .waitForElementVisible(".description-row button.description-button", short_wait)

          // As Bob, add collection A to collection B, creating a cycle of references.
          .waitForElementVisible("table.grain-list-table>tbody>tr.add-grain>td>button", short_wait)
          .click("table.grain-list-table>tbody>tr.add-grain>td>button")
          .frame(null)
          .waitForElementVisible(powerboxCardSelector(grainIdA), short_wait)
          .click(powerboxCardSelector(grainIdA))
          // Add with 'viewer' permissions.
          .waitForElementVisible(".popup.request .selected-card>form input[value='1']", short_wait)
          .click(".popup.request .selected-card>form input[value='1']")
          .click(".popup.request .selected-card>form button.connect-button")

          // Navigate back to collection A by clicking on it in collection B.
          .grainFrame()
          .waitForElementVisible("table.grain-list-table>tbody tr:nth-child(2).grain", short_wait)
          .click("table.grain-list-table>tbody tr:nth-child(2).grain .click-to-go")
          .frame(null)

          .grainFrame(grainIdA)
          .waitForElementVisible("table.grain-list-table>tbody>tr.add-grain>td>button", short_wait)
          .waitForElementVisible("table.grain-list-table>tbody tr:nth-child(3).grain", short_wait)
          .assert.containsText("table.grain-list-table>tbody tr:nth-child(3).grain td>a",
                               "Collection C")
          .click("table.grain-list-table>tbody tr:nth-child(3).grain .click-to-go")
          .frame(null)

          .grainFrame(grainIdC)
          .waitForElementVisible(".description-row p", short_wait)
          .assert.containsText(".description-row p", "This is Collection C")
          .assert.elementNotPresent(".description-row button.description-button")

          .frame(null)
          .executeAsync(function (carolIdentityId, grainIdB, done) {
            // As Bob, share Collection B to Carol.
            Meteor.call("newApiToken", { identityId: Meteor.user().loginIdentities[0].id },
                grainIdB, "petname", { allAccess: null },
                { user: { identityId: carolIdentityId, title: "Collection B", } },
                function(error, result) {
                  done({ error: error });
                });
          }, [devIdentityCarol, grainIdB], function (result) {
            browser.assert.equal(!result.value.error, true);
            browser
              .execute("window.Meteor.logout()")

              // Log in as Carol
              .loginDevAccount(devNameCarol)
              .url(browser.launch_url + "/grain/" + grainIdB)
              .grainFrame()
              .waitForElementVisible(".description-row p", short_wait)
              .assert.containsText(".description-row p", "This is Collection B")
              .waitForElementVisible(".description-row button.description-button", short_wait)

              .waitForElementVisible("table.grain-list-table>tbody tr:nth-child(2).grain",
                                     short_wait)
              .assert.containsText("table.grain-list-table>tbody tr:nth-child(2).grain td>a",
                                   "Collection A")
              .click("table.grain-list-table>tbody tr:nth-child(2).grain .click-to-go")

              .grainFrame(grainIdA)

              .waitForElementVisible(".description-row p", short_wait)
              .assert.containsText(".description-row p", "This is Collection A")

              // Carol does not have edit permissions.
              .assert.elementNotPresent(".description-row button.description-button")
              .frame(null)

              .execute("window.Meteor.logout()")

              // Log back in as Alice
              .loginDevAccount(devNameAlice)
              .url(browser.launch_url + "/grain/" + grainIdA)
              .disableGuidedTour()
              .grainFrame()

              // Unlink collection B from collection A.
              .waitForElementVisible("table.grain-list-table>tbody tr:nth-child(3).grain",
                                     short_wait)
              .waitForElementVisible("table.grain-list-table>tbody tr:nth-child(2).grain",
                                     short_wait)
              .assert.containsText("table.grain-list-table>tbody tr:nth-child(2).grain td>a",
                                   "Collection B")
              .click("table.grain-list-table>tbody tr:nth-child(2).grain td>input[type=checkbox]")
              .waitForElementVisible(".bulk-action-buttons>button[title='unlink selected grains']",
                                     short_wait)
              .click(".bulk-action-buttons>button[title='unlink selected grains']")

              .frame(null)
              .execute("window.Meteor.logout()")

              // Log back in as Carol. Check that she can no longer access collection A.
              .loginDevAccount(devNameCarol)

              // Add some characters onto the end of the URL because otherwise we trigger
              // the grain-tab restore logic and tabs open for both Collection A and Collection B.
              .url(browser.launch_url + "/grain/" + grainIdA + "/#")

              .waitForElementVisible(".grain-interstitial.request-access", medium_wait)
              .end();
          });
      });
    });
  });
};
