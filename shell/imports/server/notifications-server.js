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
import { Match, check } from "meteor/check";
import { _ } from "meteor/underscore";
import { Random } from "meteor/random";

import { waitPromise } from "/imports/server/async-helpers.ts";
import { createAppActivityDesktopNotification } from "/imports/server/desktop-notifications.js";
import { SandstormDb } from "/imports/sandstorm-db/db.js";
import { globalDb } from "/imports/db-deprecated.js";

logActivity = function (grainId, accountIdOrAnonymous, event) {
  // accountIdOrAnonymous is the string "anonymous" for an anonymous user, or is null for a
  // non-user-initiated ("background") activity.

  check(grainId, String);
  check(accountIdOrAnonymous, Match.Maybe(String));
  // `event` is always an ActivityEvent parsed from Cap'n Proto but that's too complicated to check
  // here.

  const accountId = accountIdOrAnonymous === "anonymous" ? null : accountIdOrAnonymous;

  // TODO(perf): A cached copy of the grain from when the session opened would be fine to use
  //   here, rather than looking it up every time.
  const grain = globalDb.collections.grains.findOne(grainId);
  if (!grain) {
    // Shouldn't be possible since activity events come from the grain.
    throw new Error("no such grain");
  }

  // Look up the event typedef.
  const eventType = ((grain.cachedViewInfo || {}).eventTypes || [])[event.type];
  if (!eventType) {
    throw new Error("No such event type in app's ViewInfo: " + event.type);
  }

  if (!eventType.suppressUnread) {
    // Clear the "seenAllActivity" bit for all users except the acting user.
    // TODO(perf): Consider throttling? Or should that be the app's responsibility?
    if (accountId != grain.userId) {
      globalDb.collections.grains.update(grainId, { $unset: { ownerSeenAllActivity: true } });
    }

    // Also clear on ApiTokens.
    globalDb.collections.apiTokens.update({
      "grainId": grainId,
      "owner.user.seenAllActivity": true,
      "owner.user.accountId": { $ne: accountId },
    }, { $unset: { "owner.user.seenAllActivity": true } }, { multi: true });
  }

  if (accountId) {
    // Apply auto-subscriptions.
    if (eventType.autoSubscribeToGrain) {
      globalDb.subscribeToActivity(accountId, grainId);
    }

    if (event.thread && eventType.autoSubscribeToThread) {
      globalDb.subscribeToActivity(accountId, grainId, event.thread.path || "");
    }
  }

  // Figure out whom we need to notify.
  const notifyMap = {};
  const addRecipient = recipient => {
    // Mutes take priority over subscriptions.
    if (recipient.mute) {
      notifyMap[recipient.accountId] = false;
    } else {
      if (!(recipient.accountId in notifyMap)) {
        notifyMap[recipient.accountId] = true;
      }
    }
  };

  if (accountId) {
    // Don't notify self.
    addRecipient({ accountId: accountId, mute: true });
  }

  // Notify subscribers, if desired.
  if (eventType.notifySubscribers) {
    // The grain owner is implicitly subscribed.
    addRecipient({ accountId: grain.userId });

    // Add everyone subscribed to the grain.
    globalDb.getActivitySubscriptions(grainId).forEach(addRecipient);

    if (event.thread) {
      // Add everyone subscribed to the thread.
      globalDb.getActivitySubscriptions(grainId, event.thread.path || "").forEach(addRecipient);
    }
  }

  // Add everyone who is mentioned.
  if (event.users && event.users.length > 0) {
    const promises = [];
    event.users.forEach(user => {
      if (user.identity && (user.mentioned || user.subscribed)) {
        promises.push(unwrapFrontendCap(user.identity, "identity", targetId => {
          addRecipient({ accountId: targetId });
        }));
      }
    });
    waitPromise(Promise.all(promises).then(junk => undefined));
  }

  // Make a list of everyone to notify.
  const notify = [];
  for (const accountId in notifyMap) {
    if (notifyMap[accountId]) {
      notify.push(accountId);
    }
  }

  if (notify.length > 0) {
    const notification = {
      grainId: grainId,
      path: event.path || "",
    };

    // Fields we'll update even if the notification already exists.
    const update = {
      isUnread: true,
      timestamp: new Date(),
    };

    if (event.thread) {
      notification.threadPath = event.thread.path || "";
    }

    if (accountId) {
      notification.initiatingAccount = accountId;
    } else if (accountIdOrAnonymous) {
      notification.initiatorAnonymous = true;
    }

    notification.eventType = event.type;
    update.text = eventType.verbPhrase;

    const body = (event.notification && event.notification.caption) || { defaultText: "" };

    const appActivity = {
      grainId: notification.grainId,
      path: notification.path,
      body,
      actionText: eventType.verbPhrase,
    };

    if (accountId) {
      // Look up icon urls for the responsible user and the app
      const account = Meteor.users.findOne({ _id: accountId });
      if (!account) {
        throw new Error("no such user");
      }

      SandstormDb.fillInPictureUrl(account);

      appActivity.user = {
        accountId: account._id,
        name: account.profile.name,
        avatarUrl: account.profile.pictureUrl || "",
      };
    } else if (accountIdOrAnonymous) {
      appActivity.user = { anonymous: true };
    }

    notify.forEach(targetId => {
      // Notify the account.

      // We need to know the ID of the inserted/updated document so we can embed it in the
      // desktop notification to bind them.
      const idIfInserted = Random.id(17);
      const result = globalDb.collections.notifications.findAndModify({
        query: _.extend({ userId: targetId }, notification),
        update: {
          $set: update,
          $inc: { count: 1 },
          $setOnInsert: {
            _id: idIfInserted,
          },
        },
        upsert: true,
      });

      if (!result.ok) {
        console.error("Couldn't create notification!", result.lastErrorObject);
        return;
      }

      const notificationId = result.value._id || idIfInserted;

      const desktopNotification = {
        userId: targetId,
        notificationId,
        appActivity,
      };

      createAppActivityDesktopNotification(desktopNotification);
    });
  }
};

Meteor.methods({
  testNotifications: function () {
    // Deliver a test notification of each non-grain-initiated type to the user.
    if (!this.userId) return;

    globalDb.collections.notifications.insert({
      admin: {
        action: "/admin/stats",
        type: "reportStats",
      },
      userId: this.userId,
      timestamp: new Date(),
      isUnread: true,
    });

    globalDb.collections.notifications.insert({
      userId: this.userId,
      referral: true,
      timestamp: new Date(),
      isUnread: true,
    });

    globalDb.collections.notifications.insert({
      userId: this.userId,
      identityChanges: true,
      timestamp: new Date(),
      isUnread: true,
    });

    if (Meteor.settings.public.stripePublicKey) {
      globalDb.collections.notifications.insert({
        userId: this.userId,
        mailingListBonus: true,
        timestamp: new Date(),
        isUnread: true,
      });
    }
  },
});

Meteor.publish("notifications", function () {
  return globalDb.collections.notifications.find({ userId: this.userId });
});

Meteor.publish("notificationGrains", function (notificationIds) {
  // Since publishes can't be reactive, we leave it to the client to subscribe to both
  // "notifications" and "notificationGrains" reactively.
  check(notificationIds, [String]);
  const notifications =  globalDb.collections.notifications.find({
    _id: { $in: notificationIds },
    userId: this.userId,
  }, {
    fields: { grainId: 1, initiatingAccount: 1 },
  });

  const grainIds = notifications.map(function (row) {
    return row.grainId;
  }).filter(x => x);

  const accounts = notifications.map(function (row) {
    return row.initiatingAccount;
  }).filter(x => x);

  return [
    Meteor.users.find({ _id: { $in: accounts } }, { fields: { type: 1, profile: 1 } }),
  ];
});
