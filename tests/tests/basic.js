'use strict';

module.exports = {
  "Test title" : function (browser) {
    browser
      .init()
      .assert.title('Sandstorm');
  },

  "Test github login command" : function (browser) {
    browser
      .loginGithub()
      .assert.containsText("#login-name-link", "Github User");
  },

  "Test google login command" : function (browser) {
    browser
      .loginGoogle()
      .assert.containsText("#login-name-link", "Google User");
  },

  "Test demo login command" : function (browser) {
    browser
      .loginDemo()
      .assert.containsText("#login-name-link", "Demo User")
      .end();
  }
};
