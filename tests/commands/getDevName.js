// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// TODO(cleanup): We should remove this command. It would be better to remember the
//   name when we first log in. Note that the `loginDevAccount` command helpfully passes the
//   name to its continuation.

'use strict';

var utils = require('../utils'),
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait;

exports.command = function(callback) {
    return this.execute(function () {
      return Meteor.user().profile.name;
    }, [], callback);
};
