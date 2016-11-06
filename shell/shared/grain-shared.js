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
    check(this.userId, String);

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

  moveGrainsToTrash: function (grainIds) {
    check(grainIds, [String]);

    if (this.userId) {
      Grains.update({ userId: { $eq: this.userId },
                      _id: { $in: grainIds },
                      trashed: { $exists: false }, },
                    { $set: { trashed: new Date() } },
                    { multi: true });

      const identityIds = SandstormDb.getUserIdentityIds(Meteor.user());

      ApiTokens.update({ grainId: { $in: grainIds },
                        "owner.user.identityId": { $in: identityIds },
                        trashed: { $exists: false }, },
                       { $set: { "trashed": new Date() } },
                       { multi: true });

      if (!this.isSimulation) {
        const grainsOwned = Grains.find({
          userId: { $eq: this.userId },
          _id: { $in: grainIds },
        }, { fields: { _id: 1, publicId: 1, }, });

        grainsOwned.forEach((grain) => {
          Sessions.remove({ grainId: grain._id, });
          if (grain.publicId) {
            deleteWebPublishingHandler(grain.publicId);
          }

          try {
            this.connection.sandstormBackend.shutdownGrain(grain._id, this.userId).await();
          } catch (err) {
            console.error("Failed to shutdown trashed grain", grain._id, err);
          }
        });
      }
    }
  },

  moveGrainsOutOfTrash: function (grainIds) {
    check(grainIds, [String]);

    if (this.userId) {
      Grains.update({ userId: { $eq: this.userId },
                      _id: { $in: grainIds },
                      trashed: { $exists: true }, },
                    { $unset: { trashed: 1 } },
                    { multi: true });

      const identityIds = SandstormDb.getUserIdentityIds(Meteor.user());

      ApiTokens.update({ grainId: { $in: grainIds },
                        "owner.user.identityId": { $in: identityIds },
                        "trashed": { $exists: true }, },
                       { $unset: { "trashed": 1 } },
                       { multi: true });
    }
  },

  deleteGrain: function (grainId) {
    check(grainId, String);

    if (this.userId) {
      const grainsQuery = {
        _id: grainId,
        userId: this.userId,
        trashed: { $exists: true },
      };

      let numDeleted = 0;
      if (this.isSimulation) {
        numDeleted = Grains.remove(grainsQuery);
      } else {
        numDeleted = globalDb.deleteGrains(grainsQuery, globalBackend,
                                           isDemoUser() ? "demoGrain" : "grain");
      }

      // Usually we don't automatically remove user-owned tokens that have become invalid,
      // because if we did their owner might become confused as to why they have mysteriously
      // disappeared. In this particular case, however, for tokens held by the grain owner,
      // there should be no confusion. Indeed, it would be more confusing *not* to remove these
      // tokens, because then the grain could still show up in the trash bin as a "shared with me"
      // grain after the owner clicks "delete permanently".
      //
      // Note that these tokens may be visible to other accounts if there are identities shared
      // between the accounts; by only removing 'trashed' tokens, we minimize confusion in that
      // case too.
      const apiTokensQuery = {
        grainId: grainId,
        "owner.user.identityId": { $in: SandstormDb.getUserIdentityIds(Meteor.user()) },
        "trashed": { $exists: true },
      };

      if (numDeleted > 0) {
        if (this.isSimulation) {
          ApiTokens.remove(apiTokensQuery);
        } else {
          globalDb.removeApiTokens(apiTokensQuery);
        }
      }
    }
  },

  forgetGrain: function (grainId, identityId) {
    check(grainId, String);
    check(identityId, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to forget a grain.");
    }

    if (!globalDb.userHasIdentity(this.userId, identityId)) {
      throw new Meteor.Error(403, "Current user does not have the identity " + identityId);
    }

    const query = {
      grainId: grainId,
      "owner.user.identityId": identityId,
      "trashed": { $exists: true },
    };

    if (this.isSimulation) {
      ApiTokens.remove(query);
    } else {
      globalDb.removeApiTokens(query);
    }
  },
});
