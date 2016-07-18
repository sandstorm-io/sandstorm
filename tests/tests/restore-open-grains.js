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
    appDetailsTitleSelector = utils.appDetailsTitleSelector,
    appSelector = utils.appSelector,
    actionSelector = utils.actionSelector,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;
var path = require('path');
var assetsPath = path.resolve(__dirname, '../assets');
var expectedHackerCMSButtonText = 'New Hacker CMS site';
var expectedHackerCMSGrainTitle = 'Untitled Hacker CMS site';
var expectedGitWebGrainTitle = 'Untitled GitWeb repository';
var hackerCmsAppId = "nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh";


module.exports["Test restore open grains"] = function (browser) {
  browser
    .loginDevAccount()
    // Create three Hacker CMS grains.
    .installApp("http://sandstorm.io/apps/ssjekyll8.spk",
                "ca690ad886bf920026f8b876c19539c1",
                hackerCmsAppId)
    .waitForElementVisible("#grainTitle", medium_wait)
    .assert.containsText("#grainTitle", expectedHackerCMSGrainTitle)

    .click(".navitem-create-grain>a")
    .waitForElementVisible(".app-list", medium_wait)
    .click(appSelector(hackerCmsAppId))
    .waitForElementVisible(actionSelector, short_wait)
    .click(actionSelector)
    .waitForElementVisible("#grainTitle", medium_wait)
    .assert.containsText("#grainTitle", expectedHackerCMSGrainTitle)

    .click(".navitem-create-grain>a")
    .waitForElementVisible(".app-list", medium_wait)
    .click(appSelector(hackerCmsAppId))
    .waitForElementVisible(actionSelector, short_wait)
    .click(actionSelector)
    .waitForElementVisible("#grainTitle", medium_wait)
    .assert.containsText("#grainTitle", expectedHackerCMSGrainTitle)

    .execute(function () {
      var result = [];
      var tabs = document.querySelectorAll(".navbar-grains>li");
      for (var ii = 0; ii < tabs.length; ++ii) {
        result.push(tabs[ii].getAttribute("data-grainid"))
      }
      return result;
    }, [], function (response) {
      var grainIds = response.value;
      browser.assert.equal(grainIds.length, 3);
      browser.url(function (restoreUrl) {
        browser
          .url(restoreUrl.value) // Triggers a page reload.
          .waitForElementVisible(".navbar-grains>li[data-grainid='" + grainIds[0] + "']", medium_wait)
          .waitForElementVisible(".navbar-grains>li[data-grainid='" + grainIds[1] + "']", medium_wait)
          .waitForElementVisible(".navbar-grains>li[data-grainid='" + grainIds[2] + "']", medium_wait)
          .execute(function (){
            return document.querySelectorAll(".navbar-grains>li").length;
          }, [], function (response) {
            browser.assert.equal(response.value, 3);
            browser
              .click(".navbar-grains>li[data-grainid='" + grainIds[0] + "']>button.close-button")
              .click(".navbar-grains>li[data-grainid='" + grainIds[1] + "']>button.close-button")
              .click(".navbar-grains>li[data-grainid='" + grainIds[2] + "']>button.close-button")
              .execute(function (){
                return document.querySelectorAll(".navbar-grains>li").length;
              }, [], function (response) {
                browser.assert.equal(response.value, 0);
                browser.end();
              });
          });
      });
    });
}
