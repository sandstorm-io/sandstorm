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

// This file is for various startup code that doesn't fit neatly anywhere else

var ROOT_URL = process.env.ROOT_URL;

Meteor.startup(function () {
  var baseUrlRow = Misc.findOne({_id: "BASE_URL"});

  if (!baseUrlRow) {
    // Fill data with current value in the case this is a first run
    baseUrlRow = {_id: "BASE_URL", value: ROOT_URL};
    Misc.insert(baseUrlRow);
  } else if (baseUrlRow.value !== ROOT_URL) {
    console.log("resetting oauth");
    Accounts.loginServiceConfiguration.remove({});
    baseUrlRow = {_id: "BASE_URL", value: ROOT_URL};
    Misc.update({_id: "BASE_URL"}, {$set: {value: ROOT_URL}});
  }
});
