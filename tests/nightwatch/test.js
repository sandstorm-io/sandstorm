'use strict';

module.exports = {
  "Test title" : function (browser) {
    browser
      .url("http://localhost:6080")
      .assert.title('Sandstorm')
      .end();
  },

  "Test login" : function (browser) {
    browser
      .url("http://localhost:6080/demo")
      .click("#createDemoUser")
      .assert.containsText("#login-name-link", "Demo User")
      .saveScreenshot('test.png')
      .end();
  }
};