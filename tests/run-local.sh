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

cleanExit () {
  rc=$1

  if [ $rc != 0 ]; then
    echo "Log output: "
    cat "$SANDSTORM_DIR/var/log/sandstorm.log"
  fi

  "$SANDSTORM_DIR/sandstorm" stop
  sleep 1
  rm -rf "$SANDSTORM_DIR"
  exit $rc
}

THIS_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
BUNDLE_PATH=$(readlink -f "$1")

cd "$THIS_DIR"

SANDSTORM_DIR=$THIS_DIR/tmp-sandstorm
export OVERRIDE_SANDSTORM_DEFAULT_DIR=$SANDSTORM_DIR
export PORT=$(shuf -i 10000-20000 -n 1)
export MONGO_PORT=$(shuf -i 20001-30000 -n 1)
export SMTP_LISTEN_PORT=$(shuf -i 30027-40000 -n 1)
export SMTP_OUTGOING_PORT=$(shuf -i 40001-50000 -n 1)
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

npm install

set +e

npm test

cleanExit $?
