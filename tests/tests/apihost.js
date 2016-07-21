// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

var utils = require('../utils');
var actionSelector = utils.actionSelector;
var appDetailsTitleSelector = utils.appDetailsTitleSelector;
var very_short_wait = utils.very_short_wait;
var short_wait = utils.short_wait;
var medium_wait = utils.medium_wait;
var very_long_wait = utils.very_long_wait;

module.exports = {
};

module.exports['Install and launch test app'] = function (browser) {
  browser
    .init()
    .loginDevAccount()
    // Test app code: https://github.com/kentonv/apihost-testapp
    .installApp("https://alpha-qkhxczi7kki1x49pfakw.sandstorm.io/apihost-testapp.spk", "1c3b4825b0f383c0641c01fdbc47dc07", "w304h9n5rjx1pzfa8e4guheue5mq3dkwv63aajy1rscupw6e38mh")
    .assert.containsText('#grainTitle', 'Untitled ApiHost test app instance')
    .grainFrame()
    .waitForElementPresent('iframe', medium_wait)
    .frameParent()
    .url(undefined, function (response) {
      var grainUrl = response.value;
      var expectedGrainPrefix = browser.launch_url + '/grain/';
      browser.assert.ok(grainUrl.lastIndexOf(expectedGrainPrefix, 0) === 0, "url looks like a grain URL");
      grainId = grainUrl.slice(expectedGrainPrefix.length);
    });
};

var grainId = undefined;

module.exports['Test renderTemplate with static host info'] = function (browser) {
  browser
    .grainFrame()
      .waitForElementVisible('iframe[src]', short_wait)
      .frame('offer-template')
        .waitForElementPresent('#text', short_wait)
        .getText('#text', function (result) {
          this.assert.equal(typeof result, "object");
          this.assert.equal(result.status, 0);
          var renderedTemplate = result.value;
          var endpoint = renderedTemplate.split("#")[0];

          // Inject some JS into the browser that does an XHR and returns the body.
          this
            .timeouts("script", 5000)
            .executeAsync(function(endpoint, done) {
            var xhr = new XMLHttpRequest();
            xhr.onreadystatechange = function () {
              if (xhr.readyState == 4) {
                if (xhr.status === 200) {
                  console.log("ok!")
                  console.log(xhr.responseText);
                  done({
                    type: xhr.getResponseHeader("Content-Type"),
                    content: xhr.responseText
                  });
                } else {
                  console.log("failed");
                  done(null);
                }
              }
            };
            xhr.open("GET", endpoint + "/test.static", true);
            xhr.send();
          }, [endpoint], function (result) {
            this.assert.equal(typeof result, "object");
            console.log(result);
            this.assert.equal(result.status, 0);
            this.assert.equal(typeof result.value, "object")
            this.assert.equal(result.value.type, "text/plain");
            this.assert.equal(result.value.content, "test static resource");
          });

          // Also test an OPTIONS request.
          this
            .timeouts("script", 5000)
            .executeAsync(function(endpoint, done) {
            var xhr = new XMLHttpRequest();
            xhr.onreadystatechange = function () {
              if (xhr.readyState == 4) {
                if (xhr.status === 200) {
                  console.log("ok!")
                  console.log(xhr.responseText);
                  done({
                    dav: xhr.getResponseHeader("DAV")
                  });
                } else {
                  console.log("failed");
                  done(null);
                }
              }
            };
            xhr.open("OPTIONS", endpoint, true);
            xhr.send();
          }, [endpoint], function (result) {
            this.assert.equal(typeof result, "object");
            console.log(result);
            this.assert.equal(result.status, 0);
            this.assert.equal(typeof result.value, "object")
            this.assert.equal(result.value.dav, "1, calendar-access");
          });
        })
      .frameParent()
    .frameParent()
    .end();
}
