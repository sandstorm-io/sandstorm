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

"use strict";

var utils = require("../utils"),
    actionSelector = utils.actionSelector,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait;

exports.command = function(url, packageId, appId, dontStartGrain, callback) {
  var browser = this;
  var ret = browser
    .init()
    .url(this.launch_url + "/install/" + packageId + "?url=" + url)
    .timeouts("script", long_wait + 5000)
    .executeAsync(function (timeout, done) {
      var start = Date.now();

      function isVisible(selector) {
        var element = document.querySelector(selector);
        return !!(element && element.getClientRects().length);
      }

      (function waitForInstallPage() {
        if (isVisible("#step-confirm")) {
          document.querySelector("#confirmInstall").click();
          done({ success: true, alreadyInstalled: false });
          return;
        }

        if (isVisible(".app-details") || isVisible(".grain-list-table tr.action button.action")) {
          done({ success: true, alreadyInstalled: true });
          return;
        }

        if (Date.now() - start > timeout) {
          done({
            success: false,
            url: window.location.href,
            title: document.title,
            text: document.body && document.body.innerText,
          });
          return;
        }

        setTimeout(waitForInstallPage, 100);
      })();
    }, [long_wait], function (result) {
      var value = result && result.value;
      browser.assert.ok(result.status === 0 && value && value.success,
          "install page reached confirmation or existing app details");
    })
    .pause(500)
    .element("css selector", "#confirmInstall", function(result) {
      if (result && result.status === 0) {
        this.click("#confirmInstall");
      }
    })
    .waitForElementNotPresent("#confirmInstall", long_wait)
    .url(this.launch_url + "/apps")
    .waitForElementVisible(".app-list", medium_wait)
    .resizeWindow(utils.default_width, utils.default_height);

  if (!dontStartGrain) {
    ret = ret
      // The introjs overlay often doesn't destroy itself fast enough and intercepts
      // clicks that we don't want it to intercept. So we manually disable it here.
      .disableGuidedTour()
      .url(this.launch_url + "/apps/" + appId)
      .waitForElementVisible(actionSelector, long_wait)
      .click(actionSelector)
      .waitForElementVisible("#grainTitle", medium_wait);
  }

  if (typeof callback === "function") {
    return ret.status(callback);
  } else {
    return ret;
  }
};
