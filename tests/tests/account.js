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
    very_long_wait = utils.very_long_wait;
var path = require('path');
var assetsPath = path.resolve(__dirname, '../assets');

module.exports["Test link non-login identity"] = function (browser) {
  var otherIdentityName = crypto.randomBytes(10).toString("hex");
  var otherIdentityId = crypto.createHash("sha256").update("dev:" + otherIdentityName).digest("hex");
  browser
    .loginDevAccount()
    .url(browser.launch_url + "/account")
    .waitForElementVisible("button.link-new-identity", short_wait)
    .click("button.link-new-identity")
    .waitForElementVisible(".login-buttons-list button.dev", short_wait)
    .click(".login-buttons-list button.dev")
    .waitForElementVisible("input[name=name]", short_wait)
    .setValue("input[name=name]", otherIdentityName)
    .submitForm(".login-buttons-list form.dev")
    .waitForElementVisible(".identities-tabs li[data-identity-id='" + otherIdentityId + "']",
                           medium_wait)
    .click(".identities-tabs li[data-identity-id='" + otherIdentityId + "']")
    .waitForElementPresent("input.toggle-login[data-identity-id='" + otherIdentityId + "']",
                           short_wait)
    .assert.elementNotPresent(
      "input.toggle-login[data-identity-id='" + otherIdentityId + "']:checked")
    .execute("window.Meteor.logout()")

    .waitForElementVisible(".login-buttons-list button.dev", short_wait)
    .click(".login-buttons-list button.dev")
    .waitForElementVisible("input[name=name]", short_wait)
    .setValue("input[name=name]", otherIdentityName)
    .submitForm(".login-buttons-list form.dev")
    .waitForElementVisible(".identity-login-interstitial .warning-banner", short_wait)
    .assert.containsText(".identity-login-interstitial .warning-banner",
                         "is not a login identity")
    .end();
}
