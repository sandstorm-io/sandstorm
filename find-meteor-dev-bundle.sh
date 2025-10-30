#! /bin/bash
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

# This script attempts to find Meteor's "dev bundle", which contains the node
# and mongo binaries and headers, so that we can borrow them rather than making
# users install them separately.
#
# Currently this script is not quite right. It tries to find the most-recent
# bundle, but we should probably take the bundle matching the Meteor version
# that Sandstorm is currently using. Moreover, it appears that this script's
# technique sometimes ends up with an *older* bundle than the most-recent, I
# guess because Meteor is sometimes lazy about updating the main `meteor`
# command's symlink. I have not yet deciphered enough about the Meteor
# warehouse's layout to figure out how to map directly from a version to a
# dev bundle.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

METEOR_WAREHOUSE_DIR="${METEOR_WAREHOUSE_DIR:-$HOME/.meteor}"

# If we run the meteor tool outside of `shell`, it might try to update itself. Inside `shell`, it
# sees the meteor version we're using and sticks to that.
cd "$SCRIPT_DIR/shell"

METEOR_RELEASE=${1:-$(<.meteor/release)}
CACHE_FILE="../tmp/$METEOR_RELEASE.location"

mkdir -p ../tmp
if [ -s "$CACHE_FILE" ]; then
  cat "$CACHE_FILE"
  exit
fi

echo -n "Finding meteor-tool installation (can take a few seconds)..." >&2

# TODO(cleanup): It would be nice to use a real JSON parser here, but I don't particularly want
#   to depend on one, nor do I want to depend on Node being installed.
TOOL_VERSION=$(meteor show --ejson $METEOR_RELEASE | grep '^ *"tool":' |
    sed -re 's/^.*"(meteor-tool@[^"]*)".*$/\1/g')

TOOLDIR=$(echo $TOOL_VERSION | tr @ /)

echo " $TOOL_VERSION" >&2

echo -n "$TOOLDIR" >&2
echo -n "$METEOR_WAREHOUSE_DIR/packages/$TOOLDIR/mt-os.linux.x86_64/dev_bundle" >&2
echo "$METEOR_WAREHOUSE_DIR/packages/$TOOLDIR/mt-os.linux.x86_64/dev_bundle" > "$CACHE_FILE"
cat "$CACHE_FILE"
