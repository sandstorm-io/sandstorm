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

import { computeTitleFromTokenOwnerUser } from "/imports/client/model-helpers.js";

testNotifications = () => {
  // Run on console to create some dummy notifications for the purpose of seeing what they look
  // like.

  Meteor.call("testNotifications");
};

const getNotificationPath = (notification) => {
  if (notification.admin) {
    return notification.admin.action;
  } else if (notification.referral) {
    return "/referrals";
  } else if (notification.grainId) {
    return "/grain/" + notification.grainId + (notification.path ? "/" + notification.path : "");
  } else {
    return null;
  }
};

const removeTrailingSlash = (path) => {
  while (path.slice(-1) === "/") {
    path = path.slice(0, -1);
  }

  return path;
};

Tracker.autorun(function () {
  // While the tab is visible, automatically dismiss any notifications that link to the current
  // URL.

  if (!browserTabHidden.get()) {
    const path = removeTrailingSlash(currentPath.get());
    Notifications.find().forEach((notification) => {
      if (!notification.ongoing) {
        const npath = getNotificationPath(notification);
        if (npath) {
          if (removeTrailingSlash(getNotificationPath(notification)) === path) {
            Meteor.call("dismissNotification", notification._id);
          }
        }
      }
    });
  }
});

Template.notificationsPopup.helpers({
  notifications: function () {
    Meteor.call("readAllNotifications");
    return Notifications.find({ userId: Meteor.userId() }, { sort: { timestamp: -1 } })
        .map(function (row) {
      if (row.initiatingIdentity) {
        const sender = Meteor.users.findOne({ _id: row.initiatingIdentity });
        if (sender && sender.profile) {
          row.senderName = sender.profile.name;
          SandstormDb.fillInPictureUrl(sender);
          row.senderIcon = sender.profile.pictureUrl;
        }
      } else if (row.initiatorAnonymous) {
        row.senderName = "Anonymous user";  // TODO(i18n)
        row.senderIcon = "/incognito.svg";
      }

      if (row.grainId) {
        const usage = row.senderIcon ? "grain" : "appGrid";
        const grain = Grains.findOne({ _id: row.grainId });
        const staticPrefix = window.location.protocol + "//" + globalDb.makeWildcardHost("static");
        if (grain) {
          // We own this grain.
          row.grainTitle = grain.title;

          // Hack: If we have a sender avatar, that will be the main image, and we'll show the
          //   app icon in the corner. But if we don't have a sender avatar then the app icon
          //   is going to be bigger. While the "grain" icon seems like the "correct" one to use,
          //   it is normally expected to be small, therefore may not look good if expanded. So,
          //   prefer the app icon, which is designed to be bigger.

          if (grain.packageId) {
            const pkg = Packages.findOne(grain.packageId);
            if (pkg) {
              row.grainIcon = Identicon.iconSrcForPackage(pkg, usage, staticPrefix);
            } else {
              const devPackage = DevPackages.findOne({ appId: grain.appId });
              if (devPackage) {
                row.grainIcon = Identicon.iconSrcForPackage(devPackage, usage, staticPrefix);
              }
            }
          }
        } else {
          // We have an ApiToken for this grain.
          const identityIds = SandstormDb.getUserIdentityIds(Meteor.user());
          const apiToken = ApiTokens.findOne({
            grainId: row.grainId,
            "owner.user.identityId": { $in: identityIds },
            "owner.user.denormalizedGrainMetadata": { $exists: true },
          }, {
            sort: { created: 1 },
          });

          if (apiToken) {
            const tokenOwnerUser = apiToken.owner.user;
            const meta = tokenOwnerUser.denormalizedGrainMetadata;
            row.grainIcon = Identicon.iconSrcForDenormalizedGrainMetadata(meta, usage, staticPrefix);

            const titleObj = computeTitleFromTokenOwnerUser(tokenOwnerUser);
            row.grainTitle = titleObj.title;
          }
        }
      }

      return row;
    });
  },
});

Template.notifications.helpers({
  notificationCount: function () {
    return Notifications.find({ userId: Meteor.userId(), isUnread: true }).count();
  },
});

Template.notificationItem.helpers({
  isAppUpdates: function () {
    const data = Template.currentData();
    return !!data.appUpdates;
  },

  isMailingListBonus() {
    const data = Template.currentData();
    return !!data.mailingListBonus;
  },

  isReferral() {
    const data = Template.currentData();
    return !!data.referral;
  },

  isAdminNotification() {
    const data = Template.currentData();
    return !!data.admin;
  },

  isOngoing() {
    const data = Template.currentData();
    return !!data.ongoing;
  },
});

Template.appUpdateNotificationItem.helpers({
  appUpdatesList() {
    return _.values(this.appUpdates);
  },
});

Template.appUpdateNotificationItem.events({
  "submit form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const packages = _.map(this.appUpdates, app => app.packageId);

    Meteor.call("updateApps", packages, (err) => {
      if (err) {
        window.alert(err.message);
      } else {
        Meteor.call("dismissNotification", this._id);
      }
    });
  },

  "click button[name=dismissUpdates]"(evt) {
    Meteor.call("dismissNotification", this._id);
  },
});

Template.mailingListBonusNotificationItem.helpers({
  renderStorage(sizeInBytes) {
    let size = sizeInBytes;
    let suffix = "B";
    if (size >= 1000000000) {
      size = size / 1000000000;
      suffix = "GB";
    } else if (size >= 1000000) {
      size = size / 1000000;
      suffix = "MB";
    } else if (size >= 1000) {
      size = size / 1000;
      suffix = "kB";
    }

    return Math.floor(size) + suffix;
  },

  MAILING_LIST_BONUS() {
    if (window.BlackrockPayments) {
      return BlackrockPayments.MAILING_LIST_BONUS || 0;
    } else {
      return 0;
    }
  },
});

Template.mailingListBonusNotificationItem.events({
  "submit form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    Meteor.call("subscribeMailingList", (err) => {
      if (err) {
        window.alert("Error subscribing to list: " + err.message);
      } else {
        Meteor.call("dismissNotification", this._id);
      }
    });
  },

  "click button[type=button]"(evt) {
    Meteor.call("dismissNotification", this._id);
  },
});

Template.referralNotificationItem.helpers({
  paidUser: function () {
    const plan = Meteor.user().plan;
    return plan && plan !== "free";
  },
});

Template.referralNotificationItem.events({
  "click button[type=button]"(evt) {
    evt.preventDefault();
    Meteor.call("dismissNotification", this._id);
  },
});

Template.adminNotificationItem.helpers({
  isType(type) {
    return this.admin.type === type;
  },

  actionTarget() {
    return this.admin.action;
  },

  isUrgent() {
    const map = { cantRenewFeatureKey: true, trialFeatureKeyExpired: true };
    return map[this.admin.type];
  },
});

Template.backgroundedGrainNotificationItem.helpers({
  notificationUrl: function () {
    return getNotificationPath(this);
  },

  multiple: function () {
    return (this.count || 1) > 1;
  },
});

Template.backgroundedGrainNotificationItem.events({
  "click button[type=button]"(evt) {
    // Drops the backgrounded grain's wakelock.
    Meteor.call("dismissNotification", this._id);
    evt.preventDefault();
    evt.stopPropagation();
  },
});

Template.grainActivityNotificationItem.helpers({
  notificationUrl: function () {
    return getNotificationPath(this);
  },
});

Template.grainActivityNotificationItem.events({
  "click button[type=button]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    Meteor.call("dismissNotification", this._id);
  },
});

Meteor.startup(function () {
  Meteor.subscribe("notifications");

  Meteor.autorun(function () {
    Meteor.subscribe("notificationGrains",
      Notifications.find().map(function (row) {
        return row._id;
      })
    );
  });
});

Meteor.methods({
  dismissNotification(notificationId) {
    // Client-side simulation of dismissNotification.
    Notifications.remove({ _id: notificationId });
  },
});
