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

THIS_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")

cd "$THIS_DIR"

CONTAINER_ID=$(docker run --privileged -d -p 6080:6080 -t sandstorm bash -c 'echo "IS_TESTING=true
ALLOW_DEMO_ACCOUNTS=true" >> $HOME/sandstorm/sandstorm.conf && $HOME/sandstorm/sandstorm start && sleep 5 && tail -f $HOME/sandstorm/var/log/sandstorm.log')

echo -n "Waiting for sandstorm to start."
while ! curl -s localhost:6080 > /dev/null; do
  echo -n .
  sleep .1
done;
echo

npm install

set +e

npm test
rc=$?

if [ $rc != 0 ]; then
  docker logs $CONTAINER_ID
fi

docker stop $CONTAINER_ID
docker rm $CONTAINER_ID
exit $rc
