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

var crypto      = require("crypto");
var utils       = require('../utils'),
    short_wait  = utils.short_wait,
    medium_wait = utils.medium_wait;

// Prepend 'A' so that the default handle is always valid
function randomName() {
  return "A" + crypto.randomBytes(10).toString("hex");
}

function navigateToAccountSettings(browser) {
  return browser
    .loginDevAccount()
    .disableGuidedTour()
    // Click dropdown menu, go to account settings link
    .waitForElementVisible("button.has-picture", medium_wait)
    .pause(500)
    .click("button.has-picture")
    .waitForElementVisible("a[href='/account']", medium_wait)
    .click("a[href='/account']")
    .waitForElementVisible("form.account-profile-editor", short_wait);
}

module.exports["Test profile save shows success message"] = function (browser) {
  var name   = randomName();
  var handle = name.toLowerCase();
  navigateToAccountSettings(browser)
    .waitForElementVisible("input[name=nameInput]", short_wait)
    .clearValue("input[name=nameInput]")
    .setValue("input[name=nameInput]", name)
    .waitForElementVisible("input[name=handle]", short_wait)
    .clearValue("input[name=handle]")
    .setValue("input[name=handle]", handle)
    .submitForm("form.account-profile-editor")
    .waitForElementVisible("p.flash-message.success-message", short_wait)
    .assert.textContains("p.flash-message.success-message", "Success: profile saved")
    .execute("window.Meteor.logout()")
    .end();
};

module.exports["Test profile changes persist after navigation"] = function (browser) {
  var name   = randomName();
  var handle = name.toLowerCase();
  navigateToAccountSettings(browser)
    .waitForElementVisible("input[name=nameInput]", short_wait)
    .clearValue("input[name=nameInput]")
    .setValue("input[name=nameInput]", name)
    .waitForElementVisible("input[name=handle]", short_wait)
    .clearValue("input[name=handle]")
    .setValue("input[name=handle]", handle)
    .submitForm("form.account-profile-editor")
    .waitForElementVisible("p.flash-message.success-message", short_wait)
    // Navigate away then return directly to account settings
    .url("http://local.sandstorm.io:6080")
    .waitForElementVisible("button.has-picture", medium_wait)
    .url("http://local.sandstorm.io:6080/account")
    .waitForElementVisible("form.account-profile-editor", short_wait)
    .assert.value("input[name=nameInput]", name)
    .assert.value("input[name=handle]", handle)
    .execute("window.Meteor.logout()")
    .end();
};

module.exports["Test pronoun options can each be selected and saved"] = function (browser) {
  var pronouns = ["neutral", "male", "female", "robot"];
  var b = navigateToAccountSettings(browser);
  pronouns.forEach(function(pronoun) {
    b.waitForElementPresent("option[value=" + pronoun + "]", short_wait)
     .click("select[name=pronoun] option[value=" + pronoun + "]")
     .submitForm("form.account-profile-editor")
     .waitForElementVisible("p.flash-message.success-message", short_wait)
     .assert.textContains("p.flash-message.success-message", "Success: profile saved")
     .url("http://local.sandstorm.io:6080/account")
     .waitForElementVisible("form.account-profile-editor", short_wait)
     .assert.value("select[name=pronoun]", pronoun);
  });
  b.execute("window.Meteor.logout()").end();
};

module.exports["Test handle rejects invalid characters"] = function (browser) {
  // handle pattern is ^[a-z_][a-z0-9_]*$
  navigateToAccountSettings(browser)
    .waitForElementVisible("input[name=handle]", short_wait)
    .clearValue("input[name=handle]")
    .setValue("input[name=handle]", "Invalid Handle!")
    .submitForm("form.account-profile-editor")
    .waitForElementNotPresent("p.flash-message.success-message", short_wait)
    .assert.elementPresent("form.account-profile-editor")
    .execute("window.Meteor.logout()")
    .end();
};

module.exports["Test handle rejects handle starting with number"] = function (browser) {
  // handle pattern is ^[a-z_][a-z0-9_]*$
  navigateToAccountSettings(browser)
    .waitForElementVisible("input[name=handle]", short_wait)
    .clearValue("input[name=handle]")
    .setValue("input[name=handle]", "1invalidhandle")
    .submitForm("form.account-profile-editor")
    .waitForElementNotPresent("p.flash-message.success-message", short_wait)
    .assert.elementPresent("form.account-profile-editor")
    .execute("window.Meteor.logout()")
    .end();
};

module.exports["Test empty name is rejected"] = function (browser) {
  navigateToAccountSettings(browser)
    .waitForElementVisible("input[name=nameInput]", short_wait)
    .clearValue("input[name=nameInput]")
    .submitForm("form.account-profile-editor")
    .waitForElementNotPresent("p.flash-message.success-message", short_wait)
    .assert.elementPresent("form.account-profile-editor")
    .execute("window.Meteor.logout()")
    .end();
};

module.exports["Test empty handle is rejected"] = function (browser) {
  navigateToAccountSettings(browser)
    .waitForElementVisible("input[name=handle]", short_wait)
    .clearValue("input[name=handle]")
    .submitForm("form.account-profile-editor")
    .waitForElementNotPresent("p.flash-message.success-message", short_wait)
    .assert.elementPresent("form.account-profile-editor")
    .execute("window.Meteor.logout()")
    .end();
};

module.exports["Test delete account modal appears and can be cancelled"] = function (browser) {
  navigateToAccountSettings(browser)
    .waitForElementVisible("button.delete-account", short_wait)
    .click("button.delete-account")
    .waitForElementVisible("div.user-confirm-delete", short_wait)
    .assert.elementPresent("div.user-confirm-delete")
    // Delete button should be disabled before confirmation text is typed
    .assert.attributeEquals("button.delete-account-real", "disabled", "true")
    .click("button.cancel-delete-account")
    .waitForElementNotPresent("div.user-confirm-delete", short_wait)
    .execute("window.Meteor.logout()")
    .end();
};

module.exports["Test link new credential shows login options and can be cancelled"] = function (browser) {
  navigateToAccountSettings(browser)
    .waitForElementVisible("button.link-new-credential", short_wait)
    .click("button.link-new-credential")
    .waitForElementVisible("button.cancel-link-new-credential", short_wait)
    .assert.elementPresent("button.cancel-link-new-credential")
    .click("button.cancel-link-new-credential")
    .waitForElementNotPresent("button.cancel-link-new-credential", short_wait)
    .waitForElementVisible("button.link-new-credential", short_wait)
    .execute("window.Meteor.logout()")
    .end();
};
