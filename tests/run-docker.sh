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
    docker logs $CONTAINER_ID
  fi

  docker stop $CONTAINER_ID
  docker rm $CONTAINER_ID
  exit $rc
}

THIS_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")

cd "$THIS_DIR"

export PORT=$(shuf -i 10000-65000 -n 1)
export LAUNCH_URL="http://local.sandstorm.io:$PORT"

CONTAINER_ID=$(docker run -e PORT=$PORT --privileged -d -p $PORT:$PORT -t sandstorm bash -c 'echo "IS_TESTING=true
ALLOW_DEMO_ACCOUNTS=true
BASE_URL=http://local.sandstorm.io:$PORT
WILDCARD_HOST=*.local.sandstorm.io:$PORT
PORT=$PORT" >> $HOME/sandstorm/sandstorm.conf && $HOME/sandstorm/sandstorm start && sleep 5 && tail -f $HOME/sandstorm/var/log/sandstorm.log')

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
