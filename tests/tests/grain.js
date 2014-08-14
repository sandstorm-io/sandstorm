'use strict';

module.exports = {
  "Test install" : function (browser) {
    browser.login()
      // TODO: make spks local
      .url("http://localhost:6080/install/1e1cf32e0e88389775b153760be4c6fb?url=http://sandstorm.io/apps/ghost3.spk")
      .waitForElementVisible('#step-confirm', 20000)
      .click('#confirmInstall')
      .assert.containsText('.new-grain-button', 'New Ghost');
  },

  "Test upgrade" : function (browser) {
    browser
      .url("http://localhost:6080/install/757fe4fb3b9875cf1c84ddfd858ec2b2?url=http://sandstorm.io/apps/ghost4.spk")
      .waitForElementVisible('#step-confirm', 20000)
      .assert.containsText('#confirmInstall', 'Upgrade')
      .click('#confirmInstall')
      .assert.containsText('.new-grain-button', 'New Ghost');
  },

  "Test new grain" : function (browser) {
    browser
      .click('.new-grain-button')
      .assert.containsText('#grainTitle', 'Ghost');
  },

  "Test grain frame" : function (browser) {
    browser
      .frame('grain-frame')
      .waitForElementPresent('main', 10000)
      .waitForElementPresent('.entry-title', 3000)
      .assert.containsText('.entry-title', 'Welcome to Ghost')
      .end();
  },
};
