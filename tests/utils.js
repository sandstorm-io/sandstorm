'use strict';

var wrapLoginDemo = function(test) {
  return function (browser) {
    return browser.loginDemo(test.bind(browser, browser));
  };
};

var wrapLoginGithub = function(test) {
  return function (browser) {
    return browser.loginGithub(test.bind(browser, browser));
  };
};

var wrapLoginGoogle = function(test) {
  return function (browser) {
    return browser.loginGoogle(test.bind(browser, browser));
  };
};

module.exports = {
  short_wait: 5000,
  medium_wait: 30000,
  long_wait: 60000,
  very_long_wait: 180000,
  default_width: 1280,
  default_height: 1024,
  testAllLogins: function (tests) {
    var newTests = {};

    var count = 0;
    var name, test;
    for(name in tests) {
      test = tests[name];
      if (count === 0) {
        test = wrapLoginDemo(test);
      }
      newTests['Demo: ' + name] = test;
      ++count;
    }

    count = 0;
    for(name in tests) {
      test = tests[name];
      if (count === 0) {
        test = wrapLoginGithub(test);
      }
      newTests['Github: ' + name] = test;
      ++count;
    }

    count = 0;
    for(name in tests) {
      test = tests[name];
      if (count === 0) {
        test = wrapLoginGoogle(test);
      }
      newTests['Google: ' + name] = test;
      ++count;
    }

    return newTests;
  }
};
