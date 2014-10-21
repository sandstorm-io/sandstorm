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

test -e assets/ssjekyll5.spk || curl http://sandstorm.io/apps/ssjekyll5.spk > assets/ssjekyll5.spk
test -e assets/ssjekyll6.spk || curl http://sandstorm.io/apps/ssjekyll6.spk > assets/ssjekyll6.spk
test -e assets/ssjekyll7.spk || curl http://sandstorm.io/apps/ssjekyll7.spk > assets/ssjekyll7.spk

set +e
nightwatch
