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

var utils = require("../utils");

exports.command = function (selector, callback) {
  var ret = this
    .waitForElementVisible(selector, utils.medium_wait)
    .execute(function (sel) {
      var button = document.querySelector(sel);
      if (!button) return false;
      button.click();
      return true;
    }, [selector], function (result) {
      this.assert.equal(result && result.value, true, "Topbar button was available: " + selector);
    });

  if (typeof callback === "function") {
    return ret.status(callback);
  } else {
    return ret;
  }
};
