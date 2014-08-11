# Sandstorm Tests

## Setup

Install Java. Under Debain/Ubuntu, this can be accomplished with `sudo apt-get install default-jre-headless`.

Run `npm install` to install all the node dependencies.

## Run Tests

Run the tests with `npm test`. This requires a running instance of sandstorm, and **WILL** potentially change the database. If you aren't comfortable with that, run with `./run-docker.sh`
```
