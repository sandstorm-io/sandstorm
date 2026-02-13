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
import { check } from "meteor/check";

export const SandstormAutoupdateApps = {};

SandstormAutoupdateApps.updateAppIndex = async function (db) {
  await db.updateAppIndex();
};

Meteor.methods({
  updateAppIndex: async function () {
    // An undocumented method that the admin can use to force an app index update immediately.
    // Probably not useful except for debugging.

    if (!Meteor.user().isAdmin) {
      throw new Meteor.Error(403, "Must be admin.");
    }

    await SandstormAutoupdateApps.updateAppIndex(this.connection.sandstormDb);
  },

  updateApps: async function (packages) {
    check(packages, [String]);
    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to update apps.");
    }

    const db = this.connection.sandstormDb;
    const backend = this.connection.sandstormBackend;

    for (const packageId of packages) {
      const pack = await db.collections.packages.findOneAsync({ _id: packageId });
      if (!pack || !pack.manifest) {
        throw new Error("No such package on server: " + packageId);
      } else {
        await db.addUserActionsAsync(this.userId, packageId);
        await db.upgradeGrainsAsync(pack.appId, pack.manifest.appVersion, packageId, backend);
        await db.deleteUnusedPackagesAsync(pack.appId);
      }
    }
  },
});
