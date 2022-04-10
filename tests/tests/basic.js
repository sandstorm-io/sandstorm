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
    run_xfail = utils.run_xfail;

module.exports = {
  "Test title" : function (browser) {
    browser
      .init()
      .assert.title('Sandstorm')
      .end();
  },

  "Test login command" : function (browser) {
    browser
      .loginDevAccount("TestingLogin")
      .waitForElementVisible('.topbar .account>.show-popup', short_wait)
      .assert.containsText(".topbar .account>.show-popup", "TestingLogin")
      .end();
  },
};
if (run_xfail) {
  module.exports["Test demo login command"] = function (browser) {
    browser
      .loginDemo()
      .waitForElementVisible('.topbar .account>.show-popup', short_wait)
      .assert.containsText(".topbar .account>.show-popup", "Demo")
      .end();
  };
}
