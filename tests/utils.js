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
      // https://github.com/sandstorm-io/sandstorm/issues/3615
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
  logBrowserException: function (scope, event) {
    var details = event && event.exceptionDetails ? event.exceptionDetails : {};
    var exception = details.exception || {};
    var stackTrace = details.stackTrace || {};
    var callFrames = Array.isArray(stackTrace.callFrames) ? stackTrace.callFrames : [];
    var message = exception.description || details.text || "Uncaught browser exception";
    var url = details.url || "";
    var line = typeof details.lineNumber === "number" ? details.lineNumber + 1 : null;
    var column = typeof details.columnNumber === "number" ? details.columnNumber + 1 : null;

    console.error("=== Browser exception (" + scope + ") ===");
    console.error(message);

    if (url) {
      var location = "  at " + url;
      if (line !== null) {
        location += ":" + line;
        if (column !== null) location += ":" + column;
      }

      console.error(location);
    }

    if (callFrames.length > 0) {
      callFrames.forEach(function (frame) {
        var fn = frame.functionName || "<anonymous>";
        var frameUrl = frame.url || "<unknown>";
        var frameLine = typeof frame.lineNumber === "number" ? frame.lineNumber + 1 : "?";
        var frameColumn = typeof frame.columnNumber === "number" ? frame.columnNumber + 1 : "?";
        console.error("  at " + fn + " (" + frameUrl + ":" + frameLine + ":" + frameColumn + ")");
      });
    }
  },
  appDetailsTitleSelector: '.app-details .app-details-widget .app-title',
  actionSelector: '.grain-list-table tr.action button.action'
};
