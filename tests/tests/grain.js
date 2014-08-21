'use strict';

var utils = require('../utils');
var path = require('path');
var spkPath = path.resolve(__dirname, '../assets/ssjekyll6.spk');

module.exports = utils.testAllLogins({
  "Test local install" : function (browser) {
    browser
      .click('#upload-app-button')
      .ifDemo(function () {
        browser
          .waitForElementVisible('#upload p', 1000)
          .assert.containsText('#upload p', 'demo users are not allowed');
      })
      .ifNotDemo(function () {
        browser
          .assert.containsText('#uploadButton', 'Upload');
          // TODO(someday): change ironrouter to allow larger requests, fails with 413 error now
          // .waitForElementVisible('#uploadButton', 1000)
          // .setValue('#uploadFile', spkPath)
          // .click('#uploadButton')
          // .waitForElementVisible('#step-confirm', 30000)
          // .click('#confirmInstall')
          // .assert.containsText('.new-grain-button', 'New Ghost');
      });
  },

  "Test remote install" : function (browser) {
    browser
      .url(browser.launch_url + "/install/9bb0068c51f20fea26688db0fc0647be?url=http://sandstorm.io/apps/ssjekyll7.spk")
      .waitForElementVisible('#step-confirm', 30000)
      .click('#confirmInstall')
      .assert.containsText('.new-grain-button', 'New Hacker CMS Site');
  },

  "Test upgrade" : function (browser) {
    browser
      .url(browser.launch_url + "/install/ca690ad886bf920026f8b876c19539c1?url=http://sandstorm.io/apps/ssjekyll8.spk")
      .waitForElementVisible('#step-confirm', 30000)
      .assert.containsText('#confirmInstall', 'Upgrade')
      .click('#confirmInstall')
      .assert.containsText('.new-grain-button', 'New Hacker CMS Site');
  },

  "Test downgrade" : function (browser) {
    browser
      .url(browser.launch_url + "/install/c551ac859564c996bf301627481b7273?url=http://sandstorm.io/apps/ssjekyll5.spk")
      .waitForElementVisible('#step-confirm', 30000)
      .assert.containsText('#confirmInstall', 'Downgrade')
      .click('#confirmInstall')
      .assert.containsText('.new-grain-button', 'New Hacker CMS Site');
  },

  "Test new grain" : function (browser) {
    browser
      .click('.new-grain-button')
      .assert.containsText('#grainTitle', 'Untitled Hacker CMS Site');
  },

  "Test grain frame" : function (browser) {
    browser
      .frame('grain-frame')
      .waitForElementPresent('#publish', 10000)
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
      .frame('grain-frame')
      .waitForElementPresent('#publish', 10000)
      .assert.containsText('#publish', 'Publish')
      .frame(null);
  },

  "Test grain debug" : function (browser) {
    browser
      .click('#openDebugLog')
      .pause(50)
      .windowHandles(function (windows) {
        browser.switchWindow(windows.value[1]);
      })
      .assert.containsText('#topbar', 'Debug')
      .closeWindow()
      .end();
  },
});
