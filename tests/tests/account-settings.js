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
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait;
var path = require('path');
// Use sandstorm qr code as new profile picture
var newPicPath = path.resolve(__dirname + "/../../sandstorm-qr.png");

module.exports["Test profile changes"] = function (browser) {
  // Prepend 'A' so that the default handle is valid
  var devName2 = "A" + crypto.randomBytes(10).toString("hex");
  browser
    .loginDevAccount()
    .click("a.introjs-skipbutton")
    .waitForElementNotPresent("div.introjs-overlay", short_wait)
    // Click dropdown menu, go to account settings link
    .waitForElementVisible("button.has-picture", medium_wait)
    .click("button.has-picture")
    .waitForElementVisible("a[href='/account']", medium_wait)
    .click("a[href='/account']")
    .waitForElementVisible("form.account-profile-editor", short_wait)
    // Change profile picture
    .waitForElementPresent("input[name=picture]", short_wait)
    // Make input field visible in order to manipulate it in Firefox
    .execute(function () {
        document.querySelector("input[name=picture]")
                .setAttribute("style", ""); 
      }, [])
    .perform(function (client, done) {
      client.setValue("input[name=picture]", newPicPath, function(){
        console.log("finished setting new profile picture path");
        done();
      })
    })
    .execute(function () {
      var devIdentity = Accounts.getCurrentIdentityId();
      var instance    = Blaze
                          .getView(document.querySelector(
                            'button[name=upload-picture]'))
                          .templateInstance();
      Meteor.call("uploadProfilePicture", devIdentity, (err, result) => {
        if (err) {
          instance._setActionCompleted({ error: "Upload rejected: " + err.message });
        } else {
          instance._uploadToken = result;
          instance.doUploadIfReady();
        }
      });      
    }, [])
    .waitForElementVisible('p.flash-message.success-message', medium_wait)
    .assert.containsText('p.flash-message.success-message', 'Success: picture updated')
    // Change name, handle, and pronoun
    .waitForElementVisible("input[name=nameInput]", short_wait)
    .clearValue("input[name=nameInput]")
    .setValue("input[name=nameInput]", devName2)
    .waitForElementVisible("input[name=handle]", short_wait)
    .clearValue("input[name=handle]")
    .setValue("input[name=handle]", devName2.toLowerCase())
    .waitForElementPresent("option[value=robot]", medium_wait)
    .click("select[name=pronoun] option[value=robot]")
    .submitForm("form.account-profile-editor", () => {
      browser
        .waitForElementVisible("p.success-message", short_wait)
        .assert.containsText('p.flash-message.success-message', 'Success: profile saved');
    })
    // Verify profile changes
    .assert.attributeContains('.picture-box img', 'src', 'sandstorm.io')
    .assert.value("input[name=nameInput]", devName2)
    .assert.value("input[name=handle]",    devName2.toLowerCase())
    .assert.value("select[name=pronoun]",  "robot")
    .execute("window.Meteor.logout()")
    .end();
};
