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

var querystring = Npm.require("querystring");
var https = Npm.require("https");
var fs = Npm.require("fs");
var dgram = Npm.require("dgram");
var Url = Npm.require("url");

var SANDCATS_HOSTNAME = Meteor.settings && Meteor.settings.public &&
                          Meteor.settings.public.sandcatsHostname;
var SANDCATS_VARDIR = (SANDSTORM_ALTHOME || "") + "/var/sandcats";

var ROOT_URL = Url.parse(process.env.ROOT_URL);
var HOSTNAME = ROOT_URL.hostname;
var SANDCATS_NAME; // Look at `startup` below to see where this is set

var updateSandcats = function () {
  var options = {
    hostname: SANDCATS_HOSTNAME,
    path: "/update",
    method: "POST",
    agent: false,
    key: fs.readFileSync(SANDCATS_VARDIR + "/id_rsa"),
    cert: fs.readFileSync(SANDCATS_VARDIR + "/id_rsa.pub"),
    headers: {
      "X-Sand": "cats",
      "Content-Type": "application/x-www-form-urlencoded"
    }
  };

  var req = https.request(options, function(res) {
    if (res.statusCode === 200) {
      console.log("Successfully updated sandcats IP");
    } else {
      console.error("Failed to update sandcats IP:", res.headers);
    }
  });

  var post_data = querystring.stringify({
    rawHostname : SANDCATS_NAME
  });
  req.write(post_data);
  req.end();

  req.on("error", function(err) {
    console.error("Couldn't send update sandcats hostname", err);
  });
};

var pingUdp = function () {
  var socket = dgram.createSocket("udp4");
  var secret = Random.secret(16);

  message = new Buffer(SANDCATS_NAME + " " + secret);
  socket.on("message", function (buf) {
    if (buf.toString() === secret) {
      updateSandcats();
    } else {
      console.error("Received unexpected response in UDP sandcats ping:", buf.toString());
    }
  });

  socket.send(message, 0, message.length, 8080, SANDCATS_HOSTNAME, function (err) {
    if (err) {
      console.error("Couldn't send UDP sandcats ping", err);
    }
  });

  Meteor.setTimeout(function () {
    socket.close();
  }, 10 * 1000);
};

if (SANDCATS_HOSTNAME) {
  Meteor.startup(function () {
    var i = HOSTNAME.lastIndexOf(SANDCATS_HOSTNAME);
    if (i < 0) {
      console.error("SANDCATS_BASE_DOMAIN is configured but your HOSTNAME doesn't appear to contain it:",
                    SANDCATS_HOSTNAME, HOSTNAME);
    } else {
      SANDCATS_NAME = HOSTNAME.slice(0, i - 1);
      Meteor.setInterval(pingUdp, 60 * 1000);
    }
  });
}
