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

// Here we are testing a toy app (see https://github.com/jparyani/sandstorm-test-app/tree/web-
// publishing for the code). It publishes a simple file to /var/www with a single span of id=result.
// It also has a "shutdown" button, that when clicked, changes the static published site to have the
// text "Shutdown success" and then exits.

"use strict";

var utils = require("../utils"),
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

module.exports = {};

// Source at https://github.com/jparyani/sandstorm-test-app/tree/web-publishing
module.exports["Basic web publishing"] = function (browser) {
  browser
    .init()
    .loginDevAccount()
    .installApp("http://sandstorm.io/apps/jparyani/web-publishing-1.spk",
      "ea3ef5ac80af4fb8041c635185b2a10f", "qkag0k1ta3guun74g4rxx4xfqun8a3d7vsagh3843cvvxhh6n8s0")
    .assert.containsText("#grainTitle", "Untitled WebPublishingTest grain")
    .waitForElementVisible(".grain-frame", short_wait)
    .grainFrame()
    .waitForElementVisible("#public-address", short_wait)
    .getText("#public-address", function (result) {
      this
        .url(result.value)
        .waitForElementVisible("#result", short_wait)
        .assert.containsText("#result", "Success")
        .end();
    });
};

// Source at https://github.com/jparyani/sandstorm-test-app/tree/web-publishing
module.exports["Web publishing with grain shutdown"] = function (browser) {
  browser
    .init()
    .loginDevAccount()
    .installApp("http://sandstorm.io/apps/jparyani/web-publishing-1.spk",
      "ea3ef5ac80af4fb8041c635185b2a10f", "qkag0k1ta3guun74g4rxx4xfqun8a3d7vsagh3843cvvxhh6n8s0")
    .assert.containsText("#grainTitle", "Untitled WebPublishingTest grain")
    .waitForElementVisible(".grain-frame", short_wait)
    .grainFrame()
    .waitForElementVisible("#public-address", short_wait)
    .getText("#public-address", function (result) {
      this
        .click("#shutdown")
        .pause(short_wait)
        .url(result.value)
        .waitForElementVisible("#result", short_wait)
        .assert.containsText("#result", "Shutdown success")
        .end();
    });
};
