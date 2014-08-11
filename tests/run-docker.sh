#!/bin/bash

set -euo pipefail

THIS_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")

cd $THIS_DIR/..
docker build -t sandstorm .

docker run -i -t sandstorm /bin/bash -c '$HOME/sandstorm/sandstorm start && cd /opt/src/tests && npm install && npm test'
