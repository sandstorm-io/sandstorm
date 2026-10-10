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

"use strict";

var utils = require("../utils"),
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

exports.command = function(grainId) {
  // Focuses on the iframe for `grainId`. If `grainId` is null, uses the currently-active grain.

  var self = this
      .frame(null)
      .waitForElementPresent("iframe.grain-frame", medium_wait);

  if (grainId) {
    return self.waitForElementPresent("#grain-frame-" + grainId, medium_wait)
      .frameSelector("#grain-frame-" + grainId);
  }

  return self.perform(function (client, done) {
    client.execute(function () {
      var active = window.globalGrains && window.globalGrains.getActive &&
          window.globalGrains.getActive();
      if (active && active.grainId) {
        return "#grain-frame-" + active.grainId();
      }

      return null;
    }, [], function (result) {
      var selector = result && result.value;
      if (selector) {
        client.waitForElementPresent(selector, medium_wait)
          .frameSelector(selector);
      } else {
        client.waitForElementPresent(".grain-container.active-grain iframe.grain-frame", medium_wait)
          .frameSelector(".grain-container.active-grain iframe.grain-frame");
      }

      done();
    });
  });
};
