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
      }

      if (row.grainId) {
        const grain = Grains.findOne({ _id: row.grainId });
        if (grain) {
          row.grainTitle = grain.title;

          // Hack: If we have a sender avatar, that will be the main image, and we'll show the
          //   app icon in the corner. But if we don't have a sender avatar then the app icon
          //   is going to be bigger. While the "grain" icon seems like the "correct" one to use,
          //   it is normally expected to be small, therefore may not look good if expanded. So,
          //   prefer the app icon, which is designed to be bigger.
          const usage = row.senderIcon ? "grain" : "appGrid";

          if (grain.packageId) {
            const package = Packages.findOne(grain.packageId);
            if (package) {
              row.grainIcon = Identicon.iconSrcForPackage(
                  package, usage, globalDb.makeWildcardHost("static"));
            } else {
              const devPackage = DevPackages.findOne({ appId: grain.appId });
              if (devPackage) {
                row.grainIcon = Identicon.iconSrcForPackage(
                    devPackage, usage, globalDb.makeWildcardHost("static"));
              }
            }
          } else {
            const token = ApiTokens.findOne({ grainId: row.grainId,
                "owner.user.denormalizedGrainMetadata": { $exists: true }, });
            row.grainIcon = Identicon.iconSrcForDenormalizedGrainMetadata(
                token.owner.user.denormalizedGrainMetadata, usage,
                globalDb.makeWildcardHost("static"));
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

Template.notificationsPopup.events({
  "click #notification-dropdown": function (event) {
    return false;
  },
});

Template.notificationItem.helpers({
  isAppUpdates: function () {
    return !!this.appUpdates;
  },

  hasIcon: function () {
    return !!this.senderIcon || !!this.grainIcon;
  },

  notificationUrl: function () {
    return getNotificationPath(this);
  },

  notificationTitle: function () {
    if (this.admin) {
      return "Notification from System";
    } else if (this.appUpdates) {
      return "App updates are available";
    } else if (this.ongoing) {
      return this.grainTitle + " is backgrounded";
    } else {
      return false;
    }
  },

  titleHelperText: function () {
    if (this.admin) {
      return "Dismiss this system notification";
    } else if (this.referral) {
      return "Dismiss this referral notification";
    } else if (this.ongoing) {
      return "Stop the background app";
    } else {
      return "Dismiss this notification";
    }
  },

  dismissText: function () {
    if (this.admin && this.admin.type === "reportStats") {
      return false;
    } else if (this.ongoing) {
      return "Cancel";
    } else {
      return "Dismiss";
    }
  },

  adminLink: function () {
    return this.admin && this.admin.action;
  },

  appUpdatesList: function () {
    return _.values(this.appUpdates);
  },

  paidUser: function () {
    const plan = Meteor.user().plan;
    return plan && plan !== "free";
  },

  multiple: function () {
    return (this.count || 1) > 1;
  },
});

Template.notificationItem.events({
  "click .cancel-notification": function (event) {
    Meteor.call("dismissNotification", this._id);
    return false;
  },

  "click .accept-notification": function (event) {
    if (this.appUpdates) {
      const packages = _.map(this.appUpdates, app => app.packageId);

      Meteor.call("updateApps", packages, (err) => {
        if (err) {
          window.alert(err.message);
        } else {
          Meteor.call("dismissNotification", this._id);
        }
      });
    }

    return false;
  },

  "click .dismiss-notification": function (event) {
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
