# Sandstorm Tests

## Setup

First, you need to install Java in order to run Selenium. Under Debain/Ubuntu, this can be
accomplished with `sudo apt-get install default-jre-headless`.

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

## How to dump the DOM for debugging

Stick this in the test:

    browser.execute(function () {
      return document.body.innerHTML;
    }, [], function (result) {
      console.log(result);
    });

(There's probably an easier way...)
