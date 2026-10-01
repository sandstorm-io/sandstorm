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
import { SandstormDb } from "/imports/sandstorm-db/db";
import { globalDb } from "/imports/db-deprecated";

SandstormDb.periodicCleanup(120000, () => {
  // Remove old desktop notfications regularly.
  // periodicCleanup doesn't like runs more frequent than once every two minutes
  const now = Date.now();
  const then = new Date(now - 30000); // Clear tokens older than 30 seconds.
  globalDb.collections.desktopNotifications.removeAsync({
    creationDate: { $lt: then },
  }).catch((err) => {
    console.error("Failed cleaning desktop notifications:", err);
  });
});

Meteor.publish("desktopNotifications", async function () {
  const subscribeTime = new Date();

  if (!this.userId) {
    // No desktop notifications for anonymous users.
    return [];
  }

  const db = this.connection.sandstormDb;
  const callbacks = {
    added: (doc) => {
      this.added("desktopNotifications", doc._id, doc);
    },

    changed: (newDoc, oldDoc) => {
      this.changed("desktopNotifications", newDoc._id, newDoc);
    },

    removed: (doc) => {
      this.removed("desktopNotifications", doc._id);
    },
  };

  const sub = await db.collections.desktopNotifications.find({
    userId: this.userId,
    creationDate: { $gt: subscribeTime },
  }).observeAsync(callbacks);

  this.onStop(() => {
    Promise.resolve(sub).then((s) => {
      if (typeof s === "function") { s(); } else if (s && typeof s.stop === "function") s.stop();
    }).catch((err) => {
      console.error("Failed to stop desktopNotifications observer:", err);
    });
  });

  this.ready();
});
