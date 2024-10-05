#!/bin/sh

set -e

export USER=file-builder
curl https://install.meteor.com/ | sh
export PATH=$PATH:/home/file-builder/.meteor
"$@"