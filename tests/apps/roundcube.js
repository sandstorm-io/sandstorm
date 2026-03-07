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
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

module.exports = {};

module.exports["Install"] = function (browser) {
  browser
    .loginDevAccount()
    .installApp("http://sandstorm.io/apps/jparyani/roundcube-6.spk", "373a821a7a9cde5b13258922046fe217", "0qhha1v9ne1p42s5jw7r6qq6rt5tcx80zpg1f5ptsg7ryr4hws1h")
    .assert.textContains("#grainTitle", "Untitled Roundcube mailbox");
};


module.exports["Incoming Mail"] = function (browser) {
  browser
    .waitForElementVisible('.grain-frame', short_wait)
    .grainFrame()
    .waitForElementVisible(".button-settings", short_wait)
    .pause(short_wait) // Roundcube seems to swallow the click if you click while it's doing the initial mailbox load AJAX, sadly.
    .click(".button-settings")
    .waitForElementVisible("#settings-tabs .identities > a", short_wait)
    .click("#settings-tabs .identities > a")
    .waitForElementVisible("#identities-table", short_wait)
    .getText("#identities-table #rcmrow2 .mail", function (result) {
      browser.sendEmail({
        from: "test@example.com",
        to: result.value, // XXX This should be the grain publicId email.
        subject: "Hello world email",
        body: "Hello world!",
        html: "<b>Hello world!</b>"
      }, function (err) {
        if (err) {
          browser.assert.equal(err, "");
        } else {
          browser
            .click("#toplogo")
            .waitForElementVisible(".mailbox.inbox > a", medium_wait)
            .click(".mailbox.inbox > a") // Make sure we have the inbox selected
            .pause(short_wait) // It's sad, but there's no good way to wait for the mail to be delivered other than pausing
            .click(".mailbox.inbox > a") // This is equivalent to refreshing the inbox
            .waitForElementVisible("#messagelist tbody tr:nth-child(1)", short_wait)
            .assert.textContains("#messagelist tbody tr:nth-child(1) .subject", "Hello world email");
        }
      });
    });
};

module.exports["Sending Mail"] = function (browser) {
  var to = "test@example.com";
  var subject = "Hello world response";
  var text = "Hello world!";
  browser
    .click(".compose")
    .waitForElementVisible("#composebody", short_wait)
    .setValue("table.compose-headers tr:nth-child(2) textarea", to)
    .setValue("table.compose-headers tr:nth-child(8) input", subject)
    .setValue("#composebody", text)
    .assertReceiveEmail(".send", {
      to: to,
      subject: subject,
      text: text + "\n.."
    })
    .end();
};
