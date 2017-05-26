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
    appDetailsTitleSelector = utils.appDetailsTitleSelector,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

module.exports = {};

module.exports["Test appdemo link"] = function (browser) {
  browser
    .loginDevAccount()
    .installApp("http://sandstorm.io/apps/ssjekyll8.spk",
                "ca690ad886bf920026f8b876c19539c1",
                "nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh",
                true)
    .execute("window.Meteor.logout()")
    .pause(short_wait)
    .init()
    .url(browser.launch_url + "/appdemo/nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh")
    .waitForElementVisible(".demo-startup-modal .start", medium_wait)
    .assert.containsText(".demo-startup-modal .start", "Hacker CMS")
    .click(".demo-startup-modal .start")
    .waitForElementPresent("iframe.grain-frame", short_wait)
    .grainFrame()
    .waitForElementPresent("#publish", medium_wait)
    .assert.containsText("#publish", "Publish")
    .end();
};
