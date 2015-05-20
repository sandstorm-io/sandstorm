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

var _ = require("underscore");
var execFile = require("child_process").execFile;
var assert = require("chai").assert;

var SANDSTORM_BIN = process.env["SANDSTORM_BIN"] || "/opt/sandstorm/sandstorm";

function execSandstorm(args, cb) {
  execFile(SANDSTORM_BIN, args, {timeout: 60000}, cb);
}

module.exports = {
  "sandstorm help" : function (client, done) {
    execSandstorm(["help"], function (err, stdout, stderr) {
      if (err) throw err;

      assert.include(stdout, "Controls the Sandstorm server.", "`help` contains the expected output");
      done();
    });
  },
  "sandstorm admin-token" : function (client, done) {
    execSandstorm(["admin-token"], function (err, stdout, stderr) {
      if (err) throw err;

      assert.include(stdout, "Generated new admin token.", "`admin-token` contains the expected output");
      done();
    });
  },
  "sandstorm admin-token -q" : function (client, done) {
    execSandstorm(["admin-token", "-q"], function (err, stdout, stderr) {
      if (err) throw err;

      // Expect output of 40 character token + newline
      assert.lengthOf(stdout, 41, "`admin-token -q` contains the expected output");
      done();
    });
  },
  "sandstorm reset-oauth" : function (client, done) {
    execSandstorm(["reset-oauth"], function (err, stdout, stderr) {
      if (err) throw err;

      assert.include(stdout, "reset OAuth configuration", "`reset-oauth` contains the expected output");
      done();
    });
  },
};


