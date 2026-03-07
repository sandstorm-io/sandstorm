// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2020 Sandstorm Development Group, Inc. and contributors
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
'use strict';

const {short_wait, medium_wait, long_wait} = require('../utils');
const testappPath = require('path').resolve(__dirname + "/../assets/meteor-testapp.spk");

exports.command = function() {
  return this
    .url(this.launch_url + '/apps')
    .waitForElementVisible('.upload-button', short_wait)
    // Make the hidden file input visible so we can interact with it
    .execute(function() {
      var input = document.querySelector("input[type=file]");
      if (input) {
        input.style.display = 'block';
        input.style.visibility = 'visible';
        input.style.opacity = '1';
        input.style.width = 'auto';
        input.style.height = 'auto';
      }
    }, [])
    .pause(100)
    .setValue("input[type=file]", testappPath)
    .execute(function () {
      const testappFile = document.querySelector("input[type=file]").files[0];
      uploadApp(testappFile);
    }, [])
    .waitForElementVisible('#confirmInstall', long_wait)
    .click('#confirmInstall')
}
