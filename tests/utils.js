'use strict';

var run_xfail = process.env.RUN_XFAIL !== "false";

var wrapLoginDemo = function(test) {
  return function (browser) {
    return browser.loginDemo(test.bind(browser, browser));
  };
};

var wrapLoginDev = function(test) {
  return function (browser) {
    return browser.loginDevAccount(null, false, test.bind(browser, browser));
  };
};

module.exports = {
  very_short_wait: 200,
  short_wait: 5000,
  medium_wait: 30000,
  long_wait: 60000,
  very_long_wait: 180000,
  default_width: 1280,
  default_height: 1024,
  run_xfail: run_xfail,
  testAllLogins: function (tests) {
    var newTests = {};

    var count = 0;
    var name, test;
    if (run_xfail) {
      for(name in tests) {
        test = tests[name];
        if (count === 0) {
          test = wrapLoginDemo(test);
        }
        newTests['Demo: ' + name] = test;
        ++count;
      }
    }

    count = 0;
    for(name in tests) {
      test = tests[name];
      if (count === 0) {
        test = wrapLoginDev(test);
      }
      newTests['Dev Account- ' + name] = test;
      ++count;
    }

    return newTests;
  },
  appSelector: function (appId) {
    return '.app-list>.app-button[data-app-id="' + appId + '"]';
  },
  appDetailsTitleSelector: '.app-details .app-details-widget .app-title',
  actionSelector: '.grain-list-table tr.action button.action'
};
