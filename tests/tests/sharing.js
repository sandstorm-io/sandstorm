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
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;
var expectedHackerCMSGrainTitle = "Untitled Hacker CMS site";
var expectedGitWebGrainTitle = "Untitled GitWeb repository";
var hackerCmsAppId = "nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh";

module.exports["Test open direct share link"] = function (browser) {
  // The first dev user will be automatically created with the call to installApp().
  // We need to prepend 'A' so that the default handle is always valid.
  var devName2 = "A" + crypto.randomBytes(10).toString("hex");
  browser
    .loginDevAccount(devName2)
    .executeAsync(function (done) {
      done(Meteor.userId());
    }, [], function (result) {
      var devAccountId2 = result.value;
      browser.execute("window.Meteor.logout()")
        .loginDevAccount()
        .installApp("http://sandstorm.io/apps/ssjekyll8.spk", "ca690ad886bf920026f8b876c19539c1",
                    hackerCmsAppId)
        .waitForElementVisible("#grainTitle", medium_wait)
        .assert.textContains("#grainTitle", expectedHackerCMSGrainTitle)
        .executeAsync(function (data, done) {
          var grainId = Grains.findOne()._id;
          Meteor.call("newApiToken", { accountId: Meteor.userId() },
                      grainId, "petname", { allAccess: null },
                      { user: { accountId: data, title: "user2 title", } },
                      function(error, result) {
                        Meteor.logout();
                        done({ error: error, result: result, });
                      });
        }, [devAccountId2], function (result) {
          browser.assert.equal(!result.value.error, true)
          browser

             // First, try visiting the link while already logged in.
            .loginDevAccount(devName2)
            .url(browser.launch_url + "/shared/" + result.value.result.token)
            .waitForElementVisible("iframe.grain-frame", medium_wait)
            .waitForElementVisible("#grainTitle", medium_wait)
            .assert.textContains("#grainTitle", "user2 title")
            .url(function(grainUrl) {
              browser.assert.equal(0, grainUrl.value.indexOf(browser.launch_url + "/grain/"));
            })
            .grainFrame()
            .waitForElementPresent("#publish", medium_wait)
            .assert.textContains("#publish", "Publish")
            .frame(null)

            // Next, try visiting the link while not logged in.
            .execute("window.Meteor.logout()")
            .url(browser.launch_url + "/shared/" + result.value.result.token)
            .waitForElementVisible(".grain-interstitial", short_wait)
            .assert.textContains(".grain-interstitial",
                                 "This link was intended for the user:")
            .click(".grain-interstitial button.sign-in")
            .waitForElementVisible("iframe.grain-frame", medium_wait)
            .waitForElementVisible("#grainTitle", medium_wait)
            .assert.textContains("#grainTitle", "user2 title")
            .url(function(grainUrl) {
              browser.assert.equal(0, grainUrl.value.indexOf(browser.launch_url + "/grain/"));
            })
            .grainFrame()
            .waitForElementPresent("#publish", medium_wait)
            .assert.textContains("#publish", "Publish")
            .frame(null)

            // Now try while logged in as a third user.
            .execute("window.Meteor.logout()")
            .loginDevAccount()
            .url(browser.launch_url + "/shared/" + result.value.result.token)
            .waitForElementVisible(".grain-interstitial", short_wait)
            .assert.textContains(".grain-interstitial",
                                 "This link was intended for the user:")
            .click(".grain-interstitial button.sign-in")
            .waitForElementVisible("iframe.grain-frame", medium_wait)
            .waitForElementVisible("#grainTitle", medium_wait)
            .assert.textContains("#grainTitle", "user2 title")
            .url(function(grainUrl) {
              browser.assert.equal(0, grainUrl.value.indexOf(browser.launch_url + "/grain/"));
            })
            .grainFrame()
            .waitForElementPresent("#publish", medium_wait)
            .assert.textContains("#publish", "Publish")
            .frame(null)
        });
    });
}

module.exports["Test revoked share link"] = function (browser) {
  browser
    .loginDevAccount()
    .installApp("http://sandstorm.io/apps/ssjekyll8.spk", "ca690ad886bf920026f8b876c19539c1",
                hackerCmsAppId)
    .waitForElementVisible("#grainTitle", medium_wait)
    .assert.textContains("#grainTitle", expectedHackerCMSGrainTitle)
    .executeAsync(function (done) {
      var grainId = Grains.findOne()._id;
      Meteor.call("newApiToken", { accountId: Meteor.userId() },
                  grainId, "petname", { allAccess: null },
                  { webkey: { forSharing: true }, },
                  function(error, result) {
                    done({ error: error, result: result, });
                  });
    }, [], function (result) {
      browser.assert.equal(!result.value.error, true)
      browser.executeAsync(function(tokenId, done) {
        Meteor.call("updateApiToken", tokenId, { revoked: true }, function (error) {
          Meteor.logout();
          done(error)
        });
      }, [result.value.result.id], function(error) {
        browser.assert.equal(!error.value, true);
        browser
          .url(browser.launch_url + "/shared/" + result.value.result.token)
          .waitForElementVisible(".grain-interstitial", medium_wait)
          .assert.textContains(".grain-interstitial", "Sorry, this link has been revoked")
          .loginDevAccount()
          .url(browser.launch_url + "/shared/" + result.value.result.token)
          .waitForElementVisible(".grain-interstitial", medium_wait)
          .assert.textContains(".grain-interstitial", "Sorry, this link has been revoked")
      });
    });
}

module.exports["Test share popup no permission"] = function (browser) {
  var sharePopupSelector = ".topbar .share > .show-popup";
  browser
    .loginDevAccount()
    .installApp("http://sandstorm.io/apps/ssjekyll8.spk", "ca690ad886bf920026f8b876c19539c1",
                hackerCmsAppId)
    .waitForElementVisible("#grainTitle", medium_wait)
    .assert.textContains("#grainTitle", expectedHackerCMSGrainTitle)
    .waitForElementVisible(sharePopupSelector, medium_wait)
    .url(function (grainUrl) {
      browser
        .execute("window.Meteor.logout()")
        .url(browser.launch_url)
        .url(grainUrl.value)
        .waitForElementVisible(".grain-interstitial.request-access", medium_wait)
        .assert.not.elementPresent(sharePopupSelector)
        .loginDevAccount()
        .url(grainUrl.value)
        .waitForElementVisible(".grain-interstitial.request-access", medium_wait)
        .assert.not.elementPresent(sharePopupSelector)
    }).end();
}

// TODO(cleanup): Move other sharing tests into this file.
