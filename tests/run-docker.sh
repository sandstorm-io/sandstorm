#!/bin/bash

THIS_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")

cd $THIS_DIR/..
make -j4 all .docker
CONTAINER_ID=$(docker run -d -p 6080:6080 -t sandstorm)

while ! curl -s localhost:6080 > /dev/null; do sleep .1; done;

cd $THIS_DIR
npm test
rc=$?

docker stop $CONTAINER_ID
docker rm $CONTAINER_ID
exit $rc