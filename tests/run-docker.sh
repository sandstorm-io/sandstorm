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

THIS_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")

rm -rf sandstorm_var
mkdir -p sandstorm_var/{log,mongo,pid,sandstorm/apps,sandstorm/grains,sandstorm/downloads}
chmod -R 777 sandstorm_var

cd $THIS_DIR/..
make -j4 XZ_FLAGS='-0' .docker
CONTAINER_ID=$(docker run -v `pwd`/tests/sandstorm_var:/home/sandstorm/sandstorm/var --privileged -d -p 6080:6080 -t sandstorm bash -c 'echo "IS_TESTING=true
ALLOW_DEMO_ACCOUNTS=true" >> $HOME/sandstorm/sandstorm.conf && $HOME/sandstorm/sandstorm start && sleep infinity')

while ! curl -s localhost:6080 > /dev/null; do sleep .1; done;

cd $THIS_DIR
npm install
npm test
rc=$?

if [ $rc != 0 ]; then
  cat sandstorm_var/log/sandstorm.log
fi

docker stop $CONTAINER_ID
docker rm $CONTAINER_ID
rm -rf sandstorm_var
exit $rc
