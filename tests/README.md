# Sandstorm Tests

## Setup

First, you need to install Java in order to run Selenium.
You will also need `xvfb` if you plan to run the tests against a mock X server (the default).
Under Debian/Ubuntu, these can be
installed with `sudo apt-get install default-jre-headless xvfb`.
Under Fedora, run `sudo dnf install java-latest-openjdk xorg-x11-server-Xvfb`.

Second, from the tests directory, run `npm install` to install all the node dependencies.

Third, firefox must be installed on the system.

## Run Tests -- The easy way

In the parent directory, run:

    make test

## Run Tests -- Manual

First, you have to be running selenium server. You can start one with
`java -jar selenium-server-standalone-2.53.0.jar`. If you are running on a headless
system, you will need to run `xvfb` in order to allow firefox to be runnable by selenium. You can do
this by running `xvfb-run java -jar selenium-server-standalone-2.53.0.jar`, or
running `sudo Xvfb :10 -ac`, and then `export DISPLAY=:10` before starting selenium.

Run the tests with `npm test`. This requires a running instance of sandstorm, and **WILL**
potentially change the database. If you aren't comfortable with that, use the `run-local.sh` script.
It takes a bundle as an argument, for example if you've run `make fast`, you can run
`tests/run-local.sh ./sandstorm-0-fast.tar.xz`.

## Running just one test case

Say you want to run the test defined in `tests/grain.js` whose name is
"Test grain anonymous user". You can do so like so:

    TESTCASE="tests/grain.js Test grain anonymous user" make test

The name must match exactly.

You can also run all test cases in a file:

    TESTCASE="tests/grain.js" make test

## Displaying the browser's UI during tests

By default the tests run against a mock X server, so the browser windows
are not displayed. However, it can be helpful to display the browser
windows when debugging. You can do this by setting `SHOW_BROWSER=true`:

    SHOW_BROWSER=true make test

## Dealing with tests which are expected to fail

Some tests are known to fail, either always or intermittently. Obviously
we should fix these, but so that the full test suite can remain useful
in the interim, we disable these tests by default; if you want to run
them you can set `RUN_XFAIL=true`:

    RUN_XFAIL=true make test

When writing tests, this variable is exposed as `run_xfail` in
`tests/util.js`; you can disable a test by simply wrapping it in an
if statement:

```js
if (utils.run_xfail) {
  module.exports["Test something broken"] = function (browser) {
    // ...
  };
}
```

If you need to disable a test, please make sure to open an issue for it,
and link to the issue from a comment.

## How to dump the DOM for debugging

Stick this in the test:

    browser.execute(function () {
      return document.body.innerHTML;
    }, [], function (result) {
      console.log(result);
    });

(There's probably an easier way...)
