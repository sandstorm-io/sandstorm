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
    medium_wait = utils.medium_wait,
    long_wait   = utils.long_wait;
var path = require('path');
// Use sandstorm qr code as new profile picture
var newPicPath  = path.resolve(__dirname + "/../../sandstorm-qr.png");
var testappPath = path.resolve(__dirname + "/../assets/meteor-testapp.spk");
// Prepend 'A' so that the default handle is valid
var devName2 = "A" + crypto.randomBytes(10).toString("hex");

module.exports["Test profile changes passing to testapp"] = function (browser) {
  browser
    .loginDevAccount()
    .click("a.introjs-skipbutton")
    .waitForElementNotPresent("div.introjs-overlay", short_wait)
    // Click dropdown menu, go to account settings link
    .waitForElementVisible("button.has-picture", medium_wait)
    .pause(500)
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
      var instance    = Blaze
                          .getView(document.querySelector(
                            'button[name=upload-picture]'))
                          .parentView.templateInstance();
      Meteor.call("uploadProfilePicture", (err, result) => {
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


    // upload meteor-testapp.spk, create new instance
    .uploadMeteorTestApp()
    .waitForElementVisible('button.action', medium_wait)
    .click('button.action')


    // Switch to grain frame and test data
    .waitForElementVisible('.grain-frame', medium_wait)
    .grainFrame()
    .waitForElementVisible('#name', medium_wait)
    .pause(5000)
    .assert.containsText('#name', devName2)
    .assert.containsText('#picture', 'sandstorm.io')
    .assert.containsText('#preferredHandle', devName2.toLowerCase())
    .assert.containsText('#pronouns', 'robot')

    .frameParent()
    .execute("window.Meteor.logout()")
    .end();
};
