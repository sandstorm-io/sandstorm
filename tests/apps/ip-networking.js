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
    .loginDevAccount(null, true)
    .url(browser.launch_url + "/admin/capabilities")
    .waitForElementVisible("#offer-ipnetwork", short_wait)
    .click("#offer-ipnetwork")
    .waitForElementVisible("#powerbox-offer-url", short_wait)
    .getText("#powerbox-offer-url", function(result) {
      browser
        .installApp("http://sandstorm.io/apps/jparyani/ip-networking-0.spk", "4829503496b793dffb29040208e35921", "u30m2tdzecypfv9wf11u28dgmu4wjmz3tny80dqgq5aq4ge9z460")
        .assert.containsText("#grainTitle", "Untitled IpNetworkTest")
        .pause(short_wait)
        .frame("grain-frame")
        .waitForElementVisible("#request", short_wait)
        .click("#request")
        .frame()
        .waitForElementVisible("#powerbox-request-input", short_wait)
        .setValue("#powerbox-request-input", result.value)
        .click("#powerbox-request-form button.submit")
        .frame("grain-frame")
        .waitForElementVisible("#request-result", short_wait)
        .assert.containsText("#request-result", "301 Moved Permanently");
    });
};

module.exports["Test Ip Interface"] = function (browser) {
  browser
    .loginDevAccount(null, true)
    .url(browser.launch_url + "/admin/capabilities")
    .waitForElementVisible("#offer-ipinterface", short_wait)
    .click("#offer-ipinterface")
    .waitForElementVisible("#powerbox-offer-url", short_wait)
    .getText("#powerbox-offer-url", function(result) {
      browser
        .installApp("http://sandstorm.io/apps/jparyani/ip-interface-1.spk", "0b2d293e7701341a4db74f365aef6832", "xnk8j642gzvxuxq5axts9qzg578rc4gmg1kr8qqqad81wgvan6z0")
        .assert.containsText("#grainTitle", "Untitled IpInterfaceTest")
        .pause(short_wait)
        .frame("grain-frame")
        .waitForElementVisible("#request-port", short_wait)
        .setValue("#request-port", IP_INTERFACE_TEST_PORT)
        .click("#request")
        .frame()
        .waitForElementVisible("#powerbox-request-input", short_wait)
        .setValue("#powerbox-request-input", result.value)
        .click("#powerbox-request-form button.submit")
        .frame("grain-frame")
        .waitForElementVisible("#request-result", short_wait)
        .assert.containsText("#request-result", "request:")
        .assertTcpConnection(IP_INTERFACE_TEST_PORT, "tcptest");
    });
};

