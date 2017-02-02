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

import { waitPromise } from "/imports/server/async-helpers.js";
import { createAppActivityDesktopNotification } from "/imports/server/desktop-notifications.js";

const Capnp = Npm.require("capnp");
const SupervisorCapnp = Capnp.importSystem("sandstorm/supervisor.capnp");
const SystemPersistent = SupervisorCapnp.SystemPersistent;

logActivity = function (grainId, identityIdOrAnonymous, event) {
  // identityIdOrAnonymous is the string "anonymous" for an anonymous user, or is null for a
  // non-user-initiated ("background") activity.

  check(grainId, String);
  check(identityIdOrAnonymous, Match.Maybe(String));
  // `event` is always an ActivityEvent parsed from Cap'n Proto but that's too complicated to check
  // here.

  const identityId = identityIdOrAnonymous === "anonymous" ? null : identityIdOrAnonymous;

  // TODO(perf): A cached copy of the grain from when the session opened would be fine to use
  //   here, rather than looking it up every time.
  grain = Grains.findOne(grainId);
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
    if (identityId != grain.identityId) {
      Grains.update(grainId, { $unset: { ownerSeenAllActivity: true } });
    }

    // Also clear on ApiTokens.
    ApiTokens.update({
      "grainId": grainId,
      "owner.user.seenAllActivity": true,
      "owner.user.identityId": { $ne: identityId },
    }, { $unset: { "owner.user.seenAllActivity": true } }, { multi: true });
  }

  if (identityId) {
    // Apply auto-subscriptions.
    if (eventType.autoSubscribeToGrain) {
      globalDb.subscribeToActivity(identityId, grainId);
    }

    if (event.thread && eventType.autoSubscribeToThread) {
      globalDb.subscribeToActivity(identityId, grainId, event.thread.path || "");
    }
  }

  // Figure out whom we need to notify.
  const notifyMap = {};
  const addRecipient = recipient => {
    // Mutes take priority over subscriptions.
    if (recipient.mute) {
      notifyMap[recipient.identityId] = false;
    } else {
      if (!(recipient.identityId in notifyMap)) {
        notifyMap[recipient.identityId] = true;
      }
    }
  };

  if (identityId) {
    // Don't notify self.
    addRecipient({ identityId: identityId, mute: true });
  }

  // Notify subscribers, if desired.
  if (eventType.notifySubscribers) {
    // The grain owner is implicitly subscribed.
    addRecipient({ identityId: grain.identityId });

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
          addRecipient({ identityId: targetId });
        }));
      }
    });
    waitPromise(Promise.all(promises).then(junk => undefined));
  }

  // Make a list of everyone to notify.
  const notify = [];
  for (const identityId in notifyMap) {
    if (notifyMap[identityId]) {
      notify.push(identityId);
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

    if (identityId) {
      notification.initiatingIdentity = identityId;
    } else if (identityIdOrAnonymous) {
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

    if (identityId) {
      // Look up icon urls for the responsible identity and the app
      const identity = Meteor.users.findOne({ _id: identityId });
      if (!identity) {
        throw new Error("no such identity");
      }

      SandstormDb.fillInProfileDefaults(identity);
      SandstormDb.fillInPictureUrl(identity);

      appActivity.user = {
        identityId: identity._id,
        name: identity.profile.name,
        avatarUrl: identity.profile.pictureUrl || "",
      };
    } else if (identityIdOrAnonymous) {
      appActivity.user = { anonymous: true };
    }

    notify.forEach(targetId => {
      // Notify all accounts connected with this identity.
      Meteor.users.find({ $or: [
        { "loginIdentities.id": targetId },
        { "nonloginIdentities.id": targetId },
      ], }).forEach((account) => {
        // We need to know the ID of the inserted/updated document so we can embed it in the
        // desktop notification to bind them.
        const idIfInserted = Random.id(17);
        const result = Notifications.findAndModify({
          query: _.extend({ userId: account._id }, notification),
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
          userId: account._id,
          notificationId,
          appActivity,
        };

        createAppActivityDesktopNotification(desktopNotification);
      });
    });
  }
};

Meteor.methods({
  testNotifications: function () {
    // Deliver a test notification of each non-grain-initiated type to the user.
    if (!this.userId) return;

    Notifications.insert({
      admin: {
        action: "/admin/stats",
        type: "reportStats",
      },
      userId: this.userId,
      timestamp: new Date(),
      isUnread: true,
    });

    Notifications.insert({
      userId: this.userId,
      referral: true,
      timestamp: new Date(),
      isUnread: true,
    });

    if (global.BlackrockPayments) {
      Notifications.insert({
        userId: this.userId,
        mailingListBonus: true,
        timestamp: new Date(),
        isUnread: true,
      });
    }
  },
});

Meteor.publish("notifications", function () {
  return Notifications.find({ userId: this.userId });
});

Meteor.publish("notificationGrains", function (notificationIds) {
  // Since publishes can't be reactive, we leave it to the client to subscribe to both
  // "notifications" and "notificationGrains" reactively.
  check(notificationIds, [String]);
  const notifications =  Notifications.find({
    _id: { $in: notificationIds },
    userId: this.userId,
  }, {
    fields: { grainId: 1, initiatingIdentity: 1 },
  });

  const grainIds = notifications.map(function (row) {
    return row.grainId;
  }).filter(x => x);

  const identities = notifications.map(function (row) {
    return row.initiatingIdentity;
  }).filter(x => x);

  return [
    Meteor.users.find({ _id: { $in: identities } }, { fields: { profile: 1 } }),
  ];
});
