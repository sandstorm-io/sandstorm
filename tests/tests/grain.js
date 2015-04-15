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

'use strict';

var utils = require('../utils'),
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;
var path = require('path');
var assetsPath = path.resolve(__dirname, '../assets');

module.exports = utils.testAllLogins({
  "Test local install" : function (browser) {
    browser
      .click('#upload-app-button')
      .ifDemo(function () {
        browser
          .waitForElementVisible('#upload p', medium_wait)
          .assert.containsText('#upload p', 'demo users are not allowed')
          .init()
          .waitForElementVisible('#applist-apps', medium_wait);
      })
      .ifNotDemo(function () {
        browser
          .waitForElementVisible('#uploadButton', medium_wait)
          .assert.containsText('#uploadButton', 'Upload')
          .waitForElementVisible('#uploadButton', short_wait)
          .setValue('#uploadFile', path.join(assetsPath, 'ssjekyll6.spk'))
          .click('#uploadButton')
          .waitForElementVisible('#step-confirm', long_wait)
          .click('#confirmInstall')
          .waitForElementVisible('.new-grain-button', short_wait)
          .assert.containsText('.new-grain-button', 'New Hacker CMS Site');
      });
  },

  "Test upgrade" : function (browser) {
    browser
      .click("#applist-apps > ul > li:nth-child(1)")
      .waitForElementVisible('#upload-app-button', medium_wait)
      .click('#upload-app-button')
      .ifDemo(function () {
        browser
          .waitForElementVisible('#upload p', medium_wait)
          .assert.containsText('#upload p', 'demo users are not allowed')
          .init()
          .waitForElementVisible('#applist-apps', medium_wait);
      })
      .ifNotDemo(function () {
        browser
          .waitForElementVisible('#uploadButton', medium_wait)
          .assert.containsText('#uploadButton', 'Upload')
          .waitForElementVisible('#uploadButton', short_wait)
          .setValue('#uploadFile', path.join(assetsPath, 'ssjekyll7.spk'))
          .click('#uploadButton')
          .waitForElementVisible('#step-confirm', long_wait)
          .assert.containsText('#confirmInstall', 'Upgrade')
          .click('#confirmInstall')
          .waitForElementVisible('.new-grain-button', short_wait)
          .assert.containsText('.new-grain-button', 'New Hacker CMS Site');
      });
  },

  "Test downgrade" : function (browser) {
    browser
      .click("#applist-apps > ul > li:nth-child(1)")
      .waitForElementVisible('#upload-app-button', medium_wait)
      .click('#upload-app-button')
      .ifDemo(function () {
        browser
          .waitForElementVisible('#upload p', medium_wait)
          .assert.containsText('#upload p', 'demo users are not allowed')
          .init()
          .waitForElementVisible('#applist-apps', medium_wait);
      })
      .ifNotDemo(function () {
        browser
          .waitForElementVisible('#uploadButton', medium_wait)
          .assert.containsText('#uploadButton', 'Upload')
          .waitForElementVisible('#uploadButton', short_wait)
          .setValue('#uploadFile', path.join(assetsPath, 'ssjekyll5.spk'))
          .click('#uploadButton')
          .waitForElementVisible('#step-confirm', long_wait)
          .assert.containsText('#confirmInstall', 'Downgrade')
          .click('#confirmInstall')
          .waitForElementVisible('.new-grain-button', short_wait)
          .assert.containsText('.new-grain-button', 'New Hacker CMS Site');
      });
  },

  "Test remote install" : function (browser) {
    browser
      .url(browser.launch_url + "/install/ca690ad886bf920026f8b876c19539c1?url=http://sandstorm.io/apps/ssjekyll8.spk")
      .waitForElementVisible('#step-confirm', very_long_wait)
      .click('#confirmInstall')
      .waitForElementVisible('.new-grain-button', short_wait)
      .assert.containsText('.new-grain-button', 'New Hacker CMS Site');
  },

  "Test new grain" : function (browser) {
    browser
      .click('.new-grain-button')
      .waitForElementVisible('#grainTitle', medium_wait)
      .assert.containsText('#grainTitle', 'Untitled Hacker CMS Site');
  },

  "Test grain frame" : function (browser) {
    browser
      .pause(short_wait)
      .frame('grain-frame')
      .waitForElementPresent('#publish', medium_wait)
      .assert.containsText('#publish', 'Publish')
      .frame(null);
  },

  "Test grain download" : function (browser) {
    browser
      .click('#backupGrain');
      // TODO(someday): detect if error occurred, since there's no way for selenium to verify downloads
  },

  "Test grain restart" : function (browser) {
    browser
      .click('#restartGrain')
      .pause(short_wait)
      .frame('grain-frame')
      .waitForElementPresent('#publish', medium_wait)
      .pause(short_wait)
      .assert.containsText('#publish', 'Publish')
      .frame(null);
  },

  "Test grain debug" : function (browser) {
    browser
      .click('#openDebugLog')
      .pause(short_wait)
      .windowHandles(function (windows) {
        browser.switchWindow(windows.value[1]);
      })
      .pause(short_wait)
      .assert.containsText('#topbar', 'Debug')
      .closeWindow()
      .end();
  },
});

module.exports.before = function(browser) {
  // Clear any data associated with the mock users before running the test suite.
  browser
    .init()
    .execute('window.clearMockGithubUser()')
    .execute('window.clearMockGoogleUser()');
};

module.exports["Test grain anonymous user"] = function (browser) {
  browser
    // Upload app as github user
    .loginGithub()
    .click('#upload-app-button')
    .waitForElementVisible('#uploadButton', medium_wait)
    .assert.containsText('#uploadButton', 'Upload')
    .waitForElementVisible('#uploadButton', short_wait)
    .setValue('#uploadFile', path.join(assetsPath, 'ssjekyll6.spk'))
    .click('#uploadButton')
    .waitForElementVisible('#step-confirm', long_wait)
    .click('#confirmInstall')
    // Navigate to app
    .click('#homelink')
    .waitForElementVisible('#applist-apps', medium_wait)
    .click("#applist-apps > ul > li:nth-child(2)")
    .waitForElementVisible('.new-grain-button', short_wait)
    .assert.containsText('.new-grain-button', 'New Hacker CMS Site')
    // Create grain with that user
    .click('.new-grain-button')
    .waitForElementVisible('#grainTitle', medium_wait)
    .assert.containsText('#grainTitle', 'Untitled Hacker CMS Site')
    .click('#show-share-grain')
    .waitForElementVisible("#new-share-token", short_wait)
    .click('#new-share-token')
    .waitForElementVisible('#share-token-text', medium_wait)
    // Navigate to the url with an anonymous user
    .getText('#share-token-text', function(response) {
      browser
        .execute('window.Meteor.logout()')
        .pause(short_wait)
        .url(response.value)
        .waitForElementVisible('#grainTitle', medium_wait)
        .assert.containsText('#grainTitle', 'Untitled Hacker CMS Site')
        .frame('grain-frame')
        .waitForElementPresent('#publish', medium_wait)
        .assert.containsText('#publish', 'Publish')
        .frame(null)
    });
}
