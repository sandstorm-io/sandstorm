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
  testAllLogins : function (tests) {
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
