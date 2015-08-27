// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

'use strict';

var utils = require('../utils'),
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait;

var crypto = require("crypto");

exports.command = function(name, isAdmin, callback) {
  if (!name) {
    name = crypto.randomBytes(10).toString("hex");
  }
  var isAdminString= '")';
  if (isAdmin) {
    isAdminString = '", true)';
  }
  var ret = this
    .init()
    .execute('window.loginDevAccountFast("' + name + isAdminString)
    .pause(short_wait)
    .url(this.launch_url + "/grain/new")
    .waitForElementVisible('.app-list', medium_wait)
    .resizeWindow(utils.default_width, utils.default_height);

  this.sandstormAccount = 'dev';
  if (typeof callback === "function") {
    return ret.status(callback);
  } else {
    return ret;
  }
};
