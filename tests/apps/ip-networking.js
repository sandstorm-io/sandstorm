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

// Tests the `IpNetwork` and `IpInterface` capabilities using the sandstorm-test-python app.
// The app's source code is hosted at https://github.com/zarvox/sandstorm-test-python.

var utils = require("../utils"),
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

var IP_INTERFACE_TEST_PORT = parseInt(process.env.IP_INTERFACE_TEST_PORT, 10) || "30027";

module.exports = {};

module.exports["Test Ip Networking"] = function (browser) {
  browser
    .loginDevAccount(null, true)
    .installApp("http://sandstorm.io/apps/david/sandstorm-test-python4.spk",
                "874e67d3cd02486198d046909149723c",
                "umeqc9yhncg63fjj6sahtw30nf99kfm6tgkuz8rmhn5dqtusnwah")
    .assert.containsText("#grainTitle", "Untitled Test App test page")
    .waitForElementVisible('.grain-frame', short_wait)
    .grainFrame()
      .waitForElementVisible("#powerbox-request-ipnetwork", short_wait)
      .click("#powerbox-request-ipnetwork")
    .frameParent()
    .waitForElementVisible(".popup.request .candidate-cards .powerbox-card button[data-card-id=frontendref-ipnetwork]", short_wait)
    .click(".popup.request .candidate-cards .powerbox-card button[data-card-id=frontendref-ipnetwork]")
    .grainFrame()
      .waitForElementVisible("span.token", short_wait)
      .waitForElementVisible("form.test-ip-network input[type=text]", short_wait)
      .setValue("form.test-ip-network input[type=text]", "http://build.sandstorm.io")
      .click("form.test-ip-network button")
      .waitForElementVisible("form.test-ip-network div.result", short_wait)
      .assert.containsText("form.test-ip-network div.result", "301 Moved Permanently")
    .frameParent()
};

module.exports["Test Ip Interface"] = function (browser) {
  browser
    .loginDevAccount(null, true)
    .installApp("http://sandstorm.io/apps/david/sandstorm-test-python4.spk",
                "874e67d3cd02486198d046909149723c",
                "umeqc9yhncg63fjj6sahtw30nf99kfm6tgkuz8rmhn5dqtusnwah")
    .assert.containsText("#grainTitle", "Untitled Test App test page")
    .waitForElementVisible('.grain-frame', short_wait)
    .grainFrame()
      .waitForElementVisible("#powerbox-request-ipinterface", short_wait)
      .click("#powerbox-request-ipinterface")
    .frameParent()
    .waitForElementVisible(".popup.request .candidate-cards .powerbox-card button[data-card-id=frontendref-ipinterface]", short_wait)
    .click(".popup.request .candidate-cards .powerbox-card button[data-card-id=frontendref-ipinterface]")
    .grainFrame()
      .waitForElementVisible("span.token", short_wait)
      .waitForElementVisible("form.test-ip-interface input[type=number]", short_wait)
      .setValue("form.test-ip-interface input[type=number]", IP_INTERFACE_TEST_PORT)
      .click("form.test-ip-interface button")
    .frameParent()
    .assertTcpConnection(IP_INTERFACE_TEST_PORT, "tcptest")
    .end();
};

