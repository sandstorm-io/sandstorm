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

import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { globalDb } from "/imports/db-deprecated";

Meteor.methods({
  // Methods defined in this file have meaningful latency compensation (client-side prediction)
  // potential.
  //
  // Methods for which latency compensation makes no sense are defined in grain-server.js.

  markActivityReadByOwner: async function (grainId) {
    check(grainId, String);
    check(this.userId, String);

    if (Meteor.isServer) {
      await globalDb.collections.grains.updateAsync({ _id: grainId, userId: this.userId },
                                                    { $set: { "ownerSeenAllActivity": true } });
    } else {
      globalDb.collections.grains.update({ _id: grainId, userId: this.userId },
                                         { $set: { "ownerSeenAllActivity": true } });
    }
  },

  markActivityRead: async function (grainId) {
    check(grainId, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Not logged in.");
    }

    if (Meteor.isServer) {
      await globalDb.collections.apiTokens.updateAsync(
          { "grainId": grainId, "owner.user.accountId": Meteor.userId() },
          { $set: { "owner.user.seenAllActivity": true } }, { multi: true });
    } else {
      globalDb.collections.apiTokens.update({ "grainId": grainId, "owner.user.accountId": Meteor.userId() },
                                            { $set: { "owner.user.seenAllActivity": true } }, { multi: true });
    }
  },

  moveGrainsToTrash: async function (grainIds) {
    check(grainIds, [String]);

    if (this.userId) {
      if (Meteor.isServer) {
        await globalDb.collections.grains.updateAsync({ userId: { $eq: this.userId },
                          _id: { $in: grainIds },
                          trashed: { $exists: false }, },
                        { $set: { trashed: new Date() } },
                        { multi: true });

        await globalDb.collections.apiTokens.updateAsync({ grainId: { $in: grainIds },
                          "owner.user.accountId": Meteor.userId(),
                          trashed: { $exists: false }, },
                         { $set: { "trashed": new Date() } },
                         { multi: true });
      } else {
        globalDb.collections.grains.update({ userId: { $eq: this.userId },
                        _id: { $in: grainIds },
                        trashed: { $exists: false }, },
                      { $set: { trashed: new Date() } },
                      { multi: true });

        globalDb.collections.apiTokens.update({ grainId: { $in: grainIds },
                          "owner.user.accountId": Meteor.userId(),
                          trashed: { $exists: false }, },
                         { $set: { "trashed": new Date() } },
                         { multi: true });
      }

      if (!this.isSimulation) {
        const grainsOwned = await globalDb.collections.grains.find({
          userId: { $eq: this.userId },
          _id: { $in: grainIds },
        }, { fields: { _id: 1, }, }).fetchAsync();

        for (const grain of grainsOwned) {
          await globalDb.collections.sessions.removeAsync({ grainId: grain._id, });
          try {
            await this.connection.sandstormBackend.shutdownGrain(grain._id, this.userId);
          } catch (err) {
            console.error("Failed to shutdown trashed grain", grain._id, err);
          }
        }
      }
    }
  },

  moveGrainsOutOfTrash: async function (grainIds) {
    check(grainIds, [String]);

    if (this.userId) {
      if (Meteor.isServer) {
        await globalDb.collections.grains.updateAsync({ userId: { $eq: this.userId },
                          _id: { $in: grainIds },
                          trashed: { $exists: true }, },
                        { $unset: { trashed: 1 } },
                        { multi: true });

        await globalDb.collections.apiTokens.updateAsync({ grainId: { $in: grainIds },
                          "owner.user.accountId": Meteor.userId(),
                          "trashed": { $exists: true }, },
                         { $unset: { "trashed": 1 } },
                         { multi: true });
      } else {
        globalDb.collections.grains.update({ userId: { $eq: this.userId },
                        _id: { $in: grainIds },
                        trashed: { $exists: true }, },
                      { $unset: { trashed: 1 } },
                      { multi: true });

        globalDb.collections.apiTokens.update({ grainId: { $in: grainIds },
                          "owner.user.accountId": Meteor.userId(),
                          "trashed": { $exists: true }, },
                         { $unset: { "trashed": 1 } },
                         { multi: true });
      }
    }
  },

  deleteGrain: async function (grainId) {
    check(grainId, String);

    if (this.userId) {
      const grainsQuery = {
        _id: grainId,
        userId: this.userId,
        trashed: { $exists: true },
      };

      let numDeleted = 0;
      if (this.isSimulation) {
        numDeleted = Meteor.isServer
            ? await globalDb.collections.grains.removeAsync(grainsQuery)
            : globalDb.collections.grains.remove(grainsQuery);
      } else {
        const account = await Meteor.users.findOneAsync({ _id: this.userId });
        numDeleted = await globalDb.deleteGrains(grainsQuery, globalThis.globalBackend,
            (account && account.expires) ? "demoGrain" : "grain");
      }

      // Usually we don't automatically remove user-owned tokens that have become invalid,
      // because if we did their owner might become confused as to why they have mysteriously
      // disappeared. In this particular case, however, for tokens held by the grain owner,
      // there should be no confusion. Indeed, it would be more confusing *not* to remove these
      // tokens, because then the grain could still show up in the trash bin as a "shared with me"
      // grain after the owner clicks "delete permanently".
      const apiTokensQuery = {
        grainId: grainId,
        "owner.user.accountId": Meteor.userId(),
        "trashed": { $exists: true },
      };

      if (numDeleted > 0) {
        if (this.isSimulation) {
          if (Meteor.isServer) {
            await globalDb.collections.apiTokens.removeAsync(apiTokensQuery);
          } else {
            globalDb.collections.apiTokens.remove(apiTokensQuery);
          }
        } else {
          await globalDb.removeApiTokens(apiTokensQuery);
        }
      }
    }
  },

  forgetGrain: async function (grainId) {
    check(grainId, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to forget a grain.");
    }

    const query = {
      grainId: grainId,
      "owner.user.accountId": this.userId,
      "trashed": { $exists: true },
    };

    if (this.isSimulation) {
      globalDb.collections.apiTokens.remove(query);
    } else {
      await globalDb.removeApiTokens(query, true);
    }
  },
});
