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

// Here we are testing a toy app (see https://github.com/jparyani/sandstorm-test-app/tree/ip-network
// for the code). It has a "request" button that tests the basics of an IpNetwork

"use strict";

var utils = require("../utils"),
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;

var IP_INTERFACE_TEST_PORT = parseInt(process.env.IP_INTERFACE_TEST_PORT, 10) || "30027";

module.exports = {};

module.exports["Test Ip Networking"] = function (browser) {
  browser
    // sandstorm-test-python, v0.0.9
    .installApp("https://alpha-hlngxit86q1mrs2iplnx.sandstorm.io/test-9.spk", "38372232883942128f66d0a4d3818bbf", "rwyva77wj1pnj01cjdj2kvap7c059n9ephyyg5k4s5enh5yw9rxh", false, true)
    .assert.containsText("#grainTitle", "Untitled Test App test page")
    .waitForElementVisible('.grain-frame', short_wait)
    .frame("grain-frame")
      .waitForElementVisible("#powerbox-request-ipnetwork", short_wait)
      .click("#powerbox-request-ipnetwork")
    .frameParent()
    .waitForElementVisible(".popup.request .candidate-cards .powerbox-card button[data-card-id=frontendref-ipnetwork]", short_wait)
    .click(".popup.request .candidate-cards .powerbox-card button[data-card-id=frontendref-ipnetwork]")
    .frame("grain-frame")
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
    // sandstorm-test-python, v0.0.9
    .installApp("https://alpha-hlngxit86q1mrs2iplnx.sandstorm.io/test-9.spk", "38372232883942128f66d0a4d3818bbf", "rwyva77wj1pnj01cjdj2kvap7c059n9ephyyg5k4s5enh5yw9rxh", false, true)
    .assert.containsText("#grainTitle", "Untitled Test App test page")
    .waitForElementVisible('.grain-frame', short_wait)
    .frame("grain-frame")
      .waitForElementVisible("#powerbox-request-ipinterface", short_wait)
      .click("#powerbox-request-ipinterface")
    .frameParent()
    .waitForElementVisible(".popup.request .candidate-cards .powerbox-card button[data-card-id=frontendref-ipinterface]", short_wait)
    .click(".popup.request .candidate-cards .powerbox-card button[data-card-id=frontendref-ipinterface]")
    .frame("grain-frame")
      .waitForElementVisible("span.token", short_wait)
      .waitForElementVisible("form.test-ip-interface input[type=number]", short_wait)
      .setValue("form.test-ip-interface input[type=number]", IP_INTERFACE_TEST_PORT)
      .click("form.test-ip-interface button")
    .frameParent()
    .assertTcpConnection(IP_INTERFACE_TEST_PORT, "tcptest")
    .end()
};

