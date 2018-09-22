#!/bin/bash
#
# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
# All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

set -euo pipefail

XVFB_PID=""
RUN_SELENIUM="${RUN_SELENIUM:-true}"
BUNDLE_PATH=""
SANDSTORM_TESTAPP_PATH=""
THIS_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
METEOR_DEV_BUNDLE=$("$THIS_DIR/../find-meteor-dev-bundle.sh")
NODEJS="$METEOR_DEV_BUNDLE/bin/node"
NPM="$METEOR_DEV_BUNDLE/bin/npm"

cleanExit () {
  rc=$1

  if [ $rc -ne 0 ]; then
    echo "Log output: "
    cat "$SANDSTORM_DIR/var/log/sandstorm.log"
  fi

  "$SANDSTORM_DIR/sandstorm" stop
  sleep 1

  if [ $rc -eq 0 ]; then
    # Only clean up the test directory if the test run was successful - if tests failed,
    # it's nice to be able to inspect the logs.  We wipe out $SANDSTORM_DIR before starting
    # a new test run, so this is fine.
    rm -rf "$SANDSTORM_DIR"
  fi

  if [ -n "$XVFB_PID" ] ; then
    # Send SIGINT to the selenium-server child of the backgrounded xvfb-run, so
    # it will exit cleanly and the Xvfb process will also be cleaned up.
    # We don't actually know that PID, so we find it with pgrep.
    kill $(pgrep --parent $XVFB_PID node)
    wait $XVFB_PID
  fi
  exit $rc
}

checkInstalled() {
  if ! $(which $1 >/dev/null 2>/dev/null) ; then
    echo "Couldn't find executable '$1' - try installing the $2 package?"
    exit 1
  fi
}

# Parse arguments.
while [ $# -gt 0 ] ; do
  case $1 in
    --no-selenium)
      RUN_SELENIUM="false"
      ;;
    *)
      if [ -n "$SANDSTORM_TESTAPP_PATH" ]; then
        echo "Too many arguments. Please specify Sandstorm bundle and test app SPK as two arguments."
        exit 1
      elif [ -n "$BUNDLE_PATH" ]; then
        SANDSTORM_TESTAPP_PATH=$(readlink -f "$1")
      else
        BUNDLE_PATH=$(readlink -f "$1")
      fi
      ;;
  esac
  shift
done

if [ -z "$BUNDLE_PATH" ] ; then
  echo "No bundle path specified; perhaps you meant to write '$0 sandstorm-0-fast.tar.xz test-app.spk'?"
  exit 1
fi

if [ -z "$SANDSTORM_TESTAPP_PATH" ] ; then
  echo "No test app path specified; perhaps you meant to write '$0 $BUNDLE_PATH test-app.spk'?"
  exit 1
fi

# We'll use this env var from the tests.
export SANDSTORM_TESTAPP_PATH

cd "$THIS_DIR"

checkInstalled firefox firefox

"$NPM" install
node_modules/.bin/selenium-standalone install

if [ "$RUN_SELENIUM" != "false" ] ; then
  checkInstalled java default-jre-headless
  checkInstalled xvfb-run Xvfb
  checkInstalled pgrep procps
  xvfb-run --server-args="-screen 0, 1280x1024x24" node_modules/.bin/selenium-standalone start &
  XVFB_PID=$!
fi

export SANDSTORM_DIR=$THIS_DIR/tmp-sandstorm
export OVERRIDE_SANDSTORM_DEFAULT_DIR=$SANDSTORM_DIR
# Picking some fixed ports because email tests are being flaky with system-assigned ports and we
# don't do parallel tests yet anyway.
export PORT=9000
export MONGO_PORT=9001
export SMTP_LISTEN_PORT=9002
export SMTP_OUTGOING_PORT=9003
export IP_INTERFACE_TEST_PORT=9004
export LAUNCH_URL="http://local.sandstorm.io:$PORT"

rm -rf "$SANDSTORM_DIR"
../install.sh -d -u "$BUNDLE_PATH"

echo "IS_TESTING=true
ALLOW_DEMO_ACCOUNTS=true
BASE_URL=http://local.sandstorm.io:$PORT
WILDCARD_HOST=*.local.sandstorm.io:$PORT
PORT=$PORT
MONGO_PORT=$MONGO_PORT
SMTP_LISTEN_PORT=${SMTP_LISTEN_PORT}
MAIL_URL=smtp://127.0.0.1:${SMTP_OUTGOING_PORT}
UPDATE_CHANNEL=none
" >> "$SANDSTORM_DIR/sandstorm.conf"
"$SANDSTORM_DIR/sandstorm" start

echo -n "Waiting for sandstorm to start."
COUNT=0
while ! curl -s localhost:$PORT > /dev/null; do
  if [ "$COUNT" -gt 600 ]; then  # wait 60 seconds for server to start
    echo "Sandstorm failed to start"
    cleanExit 1
  fi
  COUNT=$(($COUNT+1))
  echo -n .
  sleep .1
done;
echo

set +e

export DISABLE_DEMO=true
"$NPM" test

cleanExit $?
