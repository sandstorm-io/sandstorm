#!/bin/sh

set -e

export USER=file-builder
curl https://install.meteor.com/?release=2.3.5 | sh
export PATH=$PATH:/home/file-builder/.meteor
export METEOR_WAREHOUSE_DIR=/home/file-builder/.meteor
"$@"