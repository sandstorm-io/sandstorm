// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm Development Group, Inc. and contributors
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

"use strict";

var utils = require("../utils"),
    medium_wait = utils.medium_wait;

module.exports["Test TAPi18n replacement behavior"] = function (browser) {
  browser
    .url(browser.launch_url + "/")
    .timeouts("script", medium_wait)
    .execute(function () {
      return window.testI18nHelpers.runTapi18nRegression();
    }, [], function (result) {
      var value = result.value || {};
      browser.assert.equal(value.success, true,
          "TAPi18n regression checks passed: " + (value.failures || []).join("; "));
    })
    .end();
};
