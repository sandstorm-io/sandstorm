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

METEOR_WAREHOUSE_DIR="${METEOR_WAREHOUSE_DIR:-$HOME/.meteor}"

# Use `meteor show` to find the tool version corresponding to this release.
TOOL_VERSION=$(meteor show --ejson $(<shell/.meteor/release) | grep '^ *"tool":' |
    sed -re 's/^.*"meteor-tool@([^"]*)".*$/\1/g')

readlink -f $METEOR_WAREHOUSE_DIR/packages/meteor-tool/$TOOL_VERSION/meteor-tool-os.linux.x86_64/dev_bundle
