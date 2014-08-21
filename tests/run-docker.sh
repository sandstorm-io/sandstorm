#!/bin/bash

THIS_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")

cd $THIS_DIR/..
make -j4 XZ_FLAGS='-0' .docker
CONTAINER_ID=$(docker run -d -p 6080:6080 -t sandstorm bash -c 'echo "IS_TESTING=true
ALLOW_DEMO_ACCOUNTS=true" >> $HOME/sandstorm/sandstorm.conf && $HOME/sandstorm/sandstorm start && sleep infinity')

while ! curl -s localhost:6080 > /dev/null; do sleep .1; done;

cd $THIS_DIR
npm test
rc=$?

docker stop $CONTAINER_ID
docker rm $CONTAINER_ID
exit $rc
