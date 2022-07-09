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
var utils = require('../utils'),
    appDetailsTitleSelector = utils.appDetailsTitleSelector,
    actionSelector = utils.actionSelector,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait,
    run_xfail = utils.run_xfail;
var path = require('path');
var assetsPath = path.resolve(__dirname, '../assets');

if (run_xfail) {
  // https://github.com/sandstorm-io/sandstorm/issues/3239
  module.exports["Test link credentials"] = function (browser) {
    // Prepend 'A' so that the default handle is valid.
    var devName1 = "A" + crypto.randomBytes(10).toString("hex");
    var devName2 = "A" + crypto.randomBytes(10).toString("hex");
    var devName3 = "A" + crypto.randomBytes(10).toString("hex");
    var devCredentialId1 = crypto.createHash("sha256").update("dev:" + devName1).digest("hex");
    var devCredentialId3 = crypto.createHash("sha256").update("dev:" + devName3).digest("hex");
    browser
      .init()

      // Upgrade a demo account to a real account by linking an credential.
      .url(browser.launch_url + "/demo")
      .disableGuidedTour()
      .waitForElementVisible(".demo-startup-modal .start", medium_wait)
      .click(".demo-startup-modal .start")
      .disableGuidedTour()
      .waitForElementPresent(".main-content>.app-list", medium_wait)
      .click(".login>button.show-popup")
      .waitForElementVisible(".login-buttons-list", short_wait)
      .click(".login-buttons-list button.dev")
      .waitForElementVisible("input[name=name]", short_wait)
      .setValue("input[name=name]", devName1)
      .submitForm(".login-buttons-list form.dev")
      .waitForElementVisible("form.account-profile-editor", short_wait) // confirm profile
      // Profile defaulted to new credential's name, not "Demo User".
      .assert.attributeContains("form.account-profile-editor input[name=nameInput]", "value", devName1)
      .submitForm("form.account-profile-editor")
      .execute(function () { return Meteor.user().profile.identicon; }, [], function (response) {
        // The identicon ID is based on the credential ID.
        browser.assert.equal(response.value, devCredentialId1);
      })
      .execute("window.Meteor.logout()")

      // Linking the first credential to a new account should fail.
      .loginDevAccount(devName2)
      .url(browser.launch_url + "/account")
      .waitForElementVisible("button.link-new-credential", short_wait)
      .click("button.link-new-credential")
      .waitForElementVisible(".login-buttons-list button.dev", short_wait)
      .click(".login-buttons-list button.dev")
      .waitForElementVisible("input[name=name]", short_wait)
      .setValue("input[name=name]", devName1)
      .submitForm(".login-buttons-list form.dev")
      .waitForElementPresent(".flash-message.error-message", medium_wait)
      .assert.containsText(".flash-message.error-message", "Error linking credential")

      // Linking a third credential to the second account should succeed.
      .click("button.link-new-credential")
      .waitForElementVisible(".login-buttons-list button.dev", short_wait)
      .click(".login-buttons-list button.dev")
      .waitForElementVisible("input[name=name]", short_wait)
      .setValue("input[name=name]", devName3)
      .submitForm(".login-buttons-list form.dev")
      .waitForElementVisible(".credentials-tabs li[data-credential-id='" + devCredentialId3 + "']",
                             medium_wait)
      .click(".credentials-tabs li[data-credential-id='" + devCredentialId3 + "']")
      .waitForElementPresent("input.toggle-login[data-credential-id='" + devCredentialId3 + "']",
                             short_wait)
      .assert.elementPresent(
        "input.toggle-login[data-credential-id='" + devCredentialId3 + "']:checked")
      // Set the credential to non-login.
      .click("input.toggle-login[data-credential-id='" + devCredentialId3 + "']")
      .waitForElementNotPresent(
        "input.toggle-login[data-credential-id='" + devCredentialId3 + "']:checked", short_wait)
      .execute("window.Meteor.logout()")

      // Linking the third credential to the original account should succeed.
      //
      // If we try `loginDevAccount(devName1)`, we get stuck on waiting for the applist to appear,
      // because our original user is a demo user without a signup key.
      .execute(function (name) { window.loginDevAccount(name) }, [devName1])
      .waitForElementVisible(".account>button.show-popup", medium_wait)
      .url(browser.launch_url + "/account")
      .waitForElementVisible("button.link-new-credential", short_wait)
      .click("button.link-new-credential")
      .waitForElementVisible(".login-buttons-list button.dev", short_wait)
      .click(".login-buttons-list button.dev")
      .waitForElementVisible("input[name=name]", short_wait)
      .setValue("input[name=name]", devName3)
      .submitForm(".login-buttons-list form.dev")
      .waitForElementVisible(".credentials-tabs li[data-credential-id='" + devCredentialId3 + "']",
                             medium_wait)
      .click(".credentials-tabs li[data-credential-id='" + devCredentialId3 + "']")
      // Because it is shared with another account, the credential does not have the ability to login.
      .assert.elementNotPresent(
        "input.toggle-login[data-credential-id='" + devCredentialId3 + "']:checked")

      .end();
  };
}

module.exports["Test try login with non-login credential"] = function (browser) {
  var otherCredentialName = crypto.randomBytes(10).toString("hex");
  var otherCredentialId = crypto.createHash("sha256").update("dev:" + otherCredentialName).digest("hex");
  browser
    .loginDevAccount()
    .url(browser.launch_url + "/account")
    .waitForElementVisible("button.link-new-credential", short_wait)
    .click("button.link-new-credential")
    .waitForElementVisible(".login-buttons-list button.dev", short_wait)
    .click(".login-buttons-list button.dev")
    .waitForElementVisible("input[name=name]", short_wait)
    .setValue("input[name=name]", otherCredentialName)
    .submitForm(".login-buttons-list form.dev")
    .waitForElementVisible(".credentials-tabs li[data-credential-id='" + otherCredentialId + "']",
                           medium_wait)
    .click(".credentials-tabs li[data-credential-id='" + otherCredentialId + "']")
    .waitForElementPresent("input.toggle-login[data-credential-id='" + otherCredentialId + "']",
                           short_wait)
    .assert.elementPresent(
      "input.toggle-login[data-credential-id='" + otherCredentialId + "']:checked")
    .click("input.toggle-login[data-credential-id='" + otherCredentialId + "']")
    .waitForElementNotPresent(
      "input.toggle-login[data-credential-id='" + otherCredentialId + "']:checked", short_wait)
    .execute("window.Meteor.logout()")

    .waitForElementVisible(".login-buttons-list button.dev", short_wait)
    .click(".login-buttons-list button.dev")
    .waitForElementVisible("input[name=name]", short_wait)
    .setValue("input[name=name]", otherCredentialName)
    .submitForm(".login-buttons-list form.dev")
    .waitForElementVisible(".credential-login-interstitial .warning-banner", short_wait)
    .assert.containsText(".credential-login-interstitial .warning-banner",
                         "is not a login credential")
    .end();
}

module.exports["Test link credential from unused account"] = function (browser) {
  browser
    .loginDevAccount(null, null, function (firstCredentialName) {
      var firstCredentialId = crypto.createHash("sha256")
          .update("dev:" + firstCredentialName).digest("hex");
      browser
        .execute("window.Meteor.logout()")
        .loginDevAccount()
        .url(browser.launch_url + "/account")
        .waitForElementVisible("button.link-new-credential", short_wait)
        .click("button.link-new-credential")
        .waitForElementVisible(".login-buttons-list button.dev", short_wait)
        .click(".login-buttons-list button.dev")
        .waitForElementVisible("input[name=name]", short_wait)
        .setValue("input[name=name]", firstCredentialName)
        .submitForm(".login-buttons-list form.dev")
        .waitForElementVisible(".credentials-tabs li[data-credential-id='" + firstCredentialId + "']",
                               medium_wait)
        .click(".credentials-tabs li[data-credential-id='" + firstCredentialId + "']")
        .waitForElementPresent("input.toggle-login[data-credential-id='" + firstCredentialId + "']",
                               short_wait)
        .assert.elementPresent(
          "input.toggle-login[data-credential-id='" + firstCredentialId + "']:checked")
        .end()
    });
}
