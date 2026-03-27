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

'use strict';

var utils = require('../utils'),
    appSelector = utils.appSelector,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

module.exports = {};

module.exports["Test autoupdates"] = function (browser) {
  var appId = "nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh";
  browser
    .loginDevAccount()
    .installApp("http://sandstorm.io/apps/ssjekyll8.spk",
                "ca690ad886bf920026f8b876c19539c1",
                appId,
                true)
    .disableGuidedTour()
    .click(appSelector(appId))
    .execute("Meteor.call('fetchAppIndexTest')")
    .waitForElementVisible(".topbar .notifications .count", long_wait)
    .assert.textContains(".topbar .notifications .count", "1")
    .assert.textContains(".package-info > .version > .content", "<unknown>")
    .click(".topbar .notifications>.show-popup")
    .waitForElementVisible(".app-updates", short_wait)
    .click('.notification-list .notification-item button[type=submit]')
    .waitForElementNotPresent(".app-updates", short_wait)
    .init()
    .url(browser.launch_url + "/apps/" + appId)
    .waitForElementVisible(".package-info > .version > .content", short_wait)
    .assert.textContains(".package-info > .version > .content", "2015-06-29")
    .end();
};
