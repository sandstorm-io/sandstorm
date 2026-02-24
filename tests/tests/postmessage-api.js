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
    // test-3 introduces the JSON-formatted renderTemplate output
    .loginDevAccount()
    .installApp("https://alpha-hlngxit86q1mrs2iplnx.sandstorm.io/test-7.spk", "281d3ffbc93933001d6b28e44ffac615", "rwyva77wj1pnj01cjdj2kvap7c059n9ephyyg5k4s5enh5yw9rxh")

    .assert.textContains('#grainTitle', 'Untitled Test App test page')
    .grainFrame()
      .waitForElementPresent('#randomId', medium_wait)
      .assert.textContains('#randomId', 'initial state')
    .frameParent()
    .url(undefined, function (response) {
      var grainUrl = response.value;
      var expectedGrainPrefix = browser.launch_url + '/grain/';
      browser.assert.ok(grainUrl.lastIndexOf(expectedGrainPrefix, 0) === 0, "url looks like a grain URL");
      grainId = grainUrl.slice(expectedGrainPrefix.length);
    });
};

var grainId = undefined;

module.exports['Test setPath'] = function (browser) {
  var expectedUrl = browser.launch_url + '/grain/' + grainId + '/#setpath';
  browser
    .grainFrame()
      .click('#setPath')
      .pause(very_short_wait)
    .frameParent()
    .assert.urlEquals(expectedUrl);
    // Should link-sharing links be expected to also hold the current path?
    // If they don't, it's hard to link to specific pages in multi-page apps.
    // If they do, it might be surprising or problematic if the current view
    // is a more-privileged page than what you intend to share access to.
}

module.exports['Test setTitle'] = function (browser) {
  var origTitle = undefined;
  var randomValue = "" + Math.random();
  browser
    .getTitle(function (title) {
      origTitle = title;
    })
    .grainFrame()
      .setValue('#title', [ randomValue ] )
      .click('#setTitle')
      .pause(very_short_wait)
    .frameParent()
    .getTitle(function (title) {
      this.assert.equal(title.slice(0, randomValue.length), randomValue);
    });
};

module.exports['Test setTitle to blank'] = function (browser) {
  var origTitle = undefined;
  var blank = "";
  browser
    .getTitle(function (title) {
      origTitle = title;
    })
    .grainFrame()
      .clearValue('#title')
      .click('#setTitle')
      .pause(very_short_wait)
    .frameParent()
    .getTitle(function (title) {
      // The title ends up starting with ·, which is the separator between the (empty) requested
      // title and the server title.
      this.assert.equal(title.slice(0, 1), "·");
    });
};

module.exports['Test startSharing'] = function (browser) {
  browser
    .grainFrame()
      .click('#startSharing')
    .frameParent()
    .waitForElementVisible('.popup.share', short_wait)
    .click('button.close-popup')
    .waitForElementNotPresent('.popup.share', short_wait)
};

module.exports['Test startSharing with pathname and hash'] = function (browser) {
  const linkLabel = 'Test startSharing with pathname and hash';
  browser
    .grainFrame()
    // Post a startSharing message to open the sharing popup.
    .execute(function () {
      window.parent.postMessage({startSharing: {hash: 'hash123', pathname: 'pathname/123'}}, '*');
    })
    .frameParent()
    // Get the link without sending e-mail.
    .waitForElementVisible('#shareable-link-tab-header', short_wait)
    .click('#shareable-link-tab-header')
    // Lable this link
    .waitForElementVisible('input.label', short_wait)
    .setValue('input.label', linkLabel)
    .submitForm('.new-share-token')
    // Get link from a#share-token-text.  Check for hash and pathname.
    .waitForElementVisible('#share-token-text', short_wait)
    .assert.textContains('#share-token-text', '/pathname/123#hash123')
    // Find the link and remove it.
    .click('button.who-has-access')
    .waitForElementVisible('table.shared-links', short_wait)
    .assert.textContains('table.shared-links tr:last-child span.token-petname', linkLabel)
    .click('table.shared-links tr:last-child button.revoke-token')
    // Close the sharing popup.
    .click('button.close-popup')
    .waitForElementNotPresent('.popup.share', short_wait);
};

module.exports['Test showConnectionGraph'] = function (browser) {
  browser
    .grainFrame()
      .click('#showConnectionGraph')
    .frameParent()
    .waitForElementVisible('.popup.who-has-access', short_wait)
    .click('button.close-popup')
    .waitForElementNotPresent('.popup.who-has-access', short_wait)
};

module.exports['Test renderTemplate'] = function (browser) {
  browser
    .grainFrame()
      .click('#renderTemplate')
      .waitForElementVisible('#template-frame[data-rendered=true]', short_wait)
      .frameSelector('#template-frame[data-rendered=true]')
        .getText('#text', function (result) {
          this.assert.equal(typeof result, "object");
          this.assert.equal(result.status, 0);
          var renderedTemplate = result.value;
          var tokenInfo = JSON.parse(renderedTemplate);
          console.log(tokenInfo);
          this.assert.equal(typeof tokenInfo, "object");
          this.assert.equal(typeof tokenInfo.token, "string");
          this.assert.equal(typeof tokenInfo.host, "string");
          // Now, verify that we can actually use the API token.
          // Inject some JS into the browser that does an XHR and returns the body.
          this
            .timeouts("script", 5000)
            .executeAsync(function(tokenInfo, done) {
            var token = tokenInfo.token;
            var host = tokenInfo.host;
            var xhr = new XMLHttpRequest();
            xhr.onreadystatechange = function () {
              if (xhr.readyState == 4) {
                if (xhr.status === 200) {
                  console.log("ok!")
                  console.log(xhr.responseText);
                  done(xhr.responseText);
                } else {
                  console.log("failed");
                  done(null);
                }
              }
            };
            var apiUrl = window.location.protocol + '//' + host;
            xhr.open("GET", apiUrl, true);
            xhr.setRequestHeader("Authorization", "Bearer " + token);
            xhr.send();
          }, [tokenInfo], function (result) {
            this.assert.equal(typeof result, "object");
            this.assert.equal(result.status, 0);
            this.assert.equal(typeof result.value, "string")
            var resp = JSON.parse(result.value);
            this.assert.equal(resp.state, "initial state\n");
          });
        })
      .frameParent()
    .frameParent()
    .end();
}
