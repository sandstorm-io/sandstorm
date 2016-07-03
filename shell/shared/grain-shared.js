// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

Meteor.methods({
  // Methods defined in this file have meaningful latency compensation (client-side prediction)
  // potential.
  //
  // Methods for which latency compensation makes no sense are defined in grain-server.js.

  markActivityReadByOwner: function (grainId) {
    check(grainId, String);

    Grains.update({ _id: grainId, userId: this.userId },
                  { $set: { "ownerSeenAllActivity": true } });
  },

  markActivityRead: function (grainId, identityId) {
    check(grainId, String);
    check(identityId, String);

    if (!this.userId || !globalDb.userHasIdentity(this.userId, identityId)) {
      throw new Meteor.Error(403, "Not an identity of the current user: " + identityId);
    }

    ApiTokens.update({ "grainId": grainId, "owner.user.identityId": identityId },
                     { $set: { "owner.user.seenAllActivity": true } }, { multi: true });
  },
});
