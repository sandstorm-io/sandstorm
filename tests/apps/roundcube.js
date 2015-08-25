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
    .installApp("http://sandstorm.io/apps/jparyani/roundcube-6.spk", "373a821a7a9cde5b13258922046fe217", "0qhha1v9ne1p42s5jw7r6qq6rt5tcx80zpg1f5ptsg7ryr4hws1h")
    .assert.containsText("#grainTitle", "Untitled Roundcube Mailbox");
};

module.exports["Incoming Mail"] = function (browser) {
  browser
    .pause(short_wait)
    .frame("grain-frame")
    .getText(".topright > .username", function (result) {
      browser.sendEmail({
        from: "test@example.com",
        to: result.value,
        subject: "Hello world email",
        body: "Hello world!",
        html: "<b>Hello world!</b>"
      }, function (err) {
        if (err) {
          browser.assert.equal(err, "");
        } else {
          browser
            .click(".mailbox.inbox > a") // Make sure we have the inbox selected
            .pause(short_wait) // It's sad, but there's no good way to wait for the mail to be delivered other than pausing
            .click(".mailbox.inbox > a") // This is equivalent to refreshing the inbox
            .waitForElementVisible("#messagelist tbody tr:nth-child(1)", short_wait)
            .assert.containsText("#messagelist tbody tr:nth-child(1) .subject", "Hello world email");
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
      text: text
    });
};
