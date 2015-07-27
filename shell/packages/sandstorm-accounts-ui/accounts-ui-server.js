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

Meteor.publish("accountIdentities", function () {
  if (!Meteor.userId) return [];

  return [
    Meteor.users.find(Meteor.userId,
      {fields: {
        "profile":1,

        "services.google.id":1,
        "services.google.email":1,
        "services.google.verified_email":1,
        "services.google.name":1,
        "services.google.picture":1,
        "services.google.gender":1,

        "services.github.id":1,
        "services.github.email":1,
        "services.github.username":1,

        "services.emailToken.email":1
      }})
  ];
});

// Meteor permits users to modify their own profile by default, for some reason.
Meteor.users.deny({
  insert: function () { return true; },
  update: function () { return true; },
  remove: function () { return true; },
  fetch: []
});
