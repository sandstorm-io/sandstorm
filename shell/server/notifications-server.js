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

const Capnp = Npm.require("capnp");
const SupervisorCapnp = Capnp.importSystem("sandstorm/supervisor.capnp");
const SystemPersistent = SupervisorCapnp.SystemPersistent;

logActivity = function (grainId, identityId, event) {
  // Clear the "seenAllActivity" bit for all users except the acting user.
  // TODO(perf): Consider throttling? Or should that be the app's responsibility?
  Grains.update({ _id: grainId,
                  identityId: { $ne: identityId },
                }, { $unset: { ownerSeenAllActivity: true } });
  ApiTokens.update({ "grainId": grainId,
                     "owner.user.seenAllActivity": true,
                     "owner.user.identityId": { $ne: identityId },
                   }, { $unset: { "owner.user.seenAllActivity": true } }, { multi: true });

  if (event.users && event.users.length > 0) {
    // Some users may have been mentioned. Prepare a notification to send them.

    const notification = {
      grainId: grainId,
      isUnread: true,
      timestamp: new Date(),
      path: event.path || "",
    };

    if (identityId) {
      notification.initiatingIdentity = identityId;
    }

    if (event.notification && event.notification.caption) {
      notification.text = event.notification.caption;
    }

    const promises = [];

    event.users.forEach(user => {
      if (user.identity && user.mentioned) {
        promises.push(unwrapFrontendCap(user.identity, "identity", (targetId) => {
          Meteor.users.find({$or: [{ "loginIdentities.id": targetId },
                                   { "nonLoginIdentities.id": targetId }]})
              .forEach((account) => {
            Notifications.insert(_.extend({ userId: account._id }, notification));
          });
        }));
      }
    });

    waitPromise(Promise.all(promises).then(junk => undefined));
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
      text: { defaultText: "You can help Sandstorm by sending us some anonymous " +
                           "usage stats. Click here for more info." },
      timestamp: new Date(),
      isUnread: true,
    });

    Notifications.insert({
      userId: this.userId,
      referral: true,
      timestamp: new Date(),
      isUnread: true,
    });

    Notifications.insert({
      userId: this.userId,
      mailingListBonus: true,
      timestamp: new Date(),
      isUnread: true,
    });
  }
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
    Grains.find({ _id: { $in: grainIds } }, { fields: { title: 1 } }),
    Meteor.users.find({ _id: { $in: identities } }, { fields: { profile: 1 } }),
  ];
});
