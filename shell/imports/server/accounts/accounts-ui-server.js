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


import { Meteor } from "meteor/meteor";

// Meteor permits users to modify their own profile by default, for some reason.
Meteor.users.deny({
  insert: function () { return true; },

  update: function () { return true; },

  remove: function () { return true; },

  fetch: [],
});

Meteor.publish("getMyUsage", function () {
  const db = this.connection.sandstormDb;
  if (this.userId) {
    // TODO(someday): Make this reactive.
    const user = Meteor.users.findOne(this.userId);
    const usage = db.getMyUsage(user);
    this.added("users", this.userId, {
      pseudoUsage: usage,
    });
  }

  this.ready();
});
