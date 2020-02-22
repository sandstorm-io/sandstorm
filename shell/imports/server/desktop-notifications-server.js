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

SandstormDb.periodicCleanup(120000, () => {
  // Remove old desktop notfications regularly.
  // periodicCleanup doesn't like runs more frequent than once every two minutes
  const now = Date.now();
  const then = new Date(now - 30000); // Clear tokens older than 30 seconds.
  globalDb.collections.desktopNotifications.find({
    creationDate: { $lt: then },
  }).forEach((doc) => {
    globalDb.collections.desktopNotifications.remove({
      _id: doc._id,
    });
  });
});

Meteor.publish("desktopNotifications", function () {
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

  const sub = db.collections.desktopNotifications.find({
    userId: this.userId,
    creationDate: { $gt: subscribeTime },
  }).observe(callbacks);

  this.onStop(() => {
    if (sub) {
      sub.stop();
    }
  });

  this.ready();
});
