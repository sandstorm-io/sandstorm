#!/bin/bash

set -euo pipefail

THIS_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")

cd $THIS_DIR/..
make -j4
docker build -t sandstorm .
docker run -p 6080:6080 -t sandstorm &

cd $THIS_DIR
npm test
rc=$?

[[ -z "$(jobs -p)" ]] || kill $(jobs -p)
exit $rc