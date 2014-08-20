'use strict';

module.exports = {
  "Test remote install" : function (browser) {
    browser.login()
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
      .waitForElementPresent('main', 10000)
      .waitForElementPresent('.entry-title', 3000)
      .assert.containsText('.entry-title', 'Welcome to Ghost')
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
};
