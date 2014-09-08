# Sandstorm Tests

## Setup

Install Java. Under Debain/Ubuntu, this can be accomplished with `sudo apt-get install default-jre-headless`.

Run `npm install` to install all the node dependencies.

## Run Tests

First, you have to be running selenium server. You can start one with `./node_modules/selenium-standalone/bin/start-selenium`. Wait for a line that looks like `Started org.openqa.jetty.jetty.Server...` before running tests.

Run the tests with `npm test`. This requires a running instance of sandstorm, and **WILL** potentially change the database. If you aren't comfortable with that, run with `./run-docker.sh`
```
