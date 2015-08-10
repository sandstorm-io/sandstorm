// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

// This file implements the common shell components such as the top bar.
// It also covers the root page.

browseHome = function() {
  Router.go("root");
}

if (Meteor.isClient) {
  getOrigin = function() {
    return document.location.protocol + "//" + document.location.host;
  }
}

if (Meteor.isServer) {
  // Set up browser policy.
  //
  // Note that by default (when the browser-policy package is added), Content-Security-Policy will
  // already be set to same-origin-only for everything except XHR and WebSocket. Eval is disabled,
  // but inline script are enabled.
  //
  // TODO(security): Consider disallowing inline scripts. Currently this forces Meteor to do an
  //   extra round trip on startup to fetch server settings. That seems like something that could
  //   be fixed in Meteor (e.g. embed the settings as JSON text rather than script). Startup time
  //   is incredibly important, and Meteor's templating system (which we use to render all our
  //   HTML) already does a good job of protecting us from script injection, so right now I think
  //   we should favor avoiding the round trip.
  //
  // TODO(someday): Detect when an app tries to navigate off-site using CSP's violation reporting
  //   feature. Ask the user whether they want to open the link in a new tab. This is an annoying
  //   prompt, but if we just open the tab directly then apps can trivially leak by opening tabs
  //   with encoded URLs to an evil server. Although, this attack would be very detectable to the
  //   user, so maybe it's not a big deal...

  BrowserPolicy.framing.disallow();  // Disallow framing of the UI.
  BrowserPolicy.content.allowFrameOrigin(getWildcardOrigin());

  // Allow anything to be loaded from the static asset host.
  var Url = Npm.require("url");
  var staticAssetHost = Url.parse(process.env.ROOT_URL).protocol + "//" +
                        globalDb.makeWildcardHost("static");
  BrowserPolicy.content.allowImageOrigin(staticAssetHost);
  BrowserPolicy.content.allowScriptOrigin(staticAssetHost);
  BrowserPolicy.content.allowFontOrigin(staticAssetHost);
  BrowserPolicy.content.allowConnectOrigin(staticAssetHost);

  Meteor.publish("grainsMenu", function () {
    if (this.userId) {
      if (Meteor.settings.public.quotaEnabled) {
        // Hack: Fire off an asynchronous update to the user's storage usage whenever they open the
        //   front page.
        // TODO(someday): Implement the ability to reactively subscribe to storage usage from the
        //   back-end?
        var userId = this.userId;
        sandstormBackend.getUserStorageUsage(userId).then(function (results) {
          inMeteor(function () {
            Meteor.users.update(userId, {$set: {storageUsage: parseInt(results.size)}});
          });
        }).catch(function (err) {
          if (err.kjType !== "unimplemented") {
            console.error(err.stack);
          }
        });
      }

      return [
        UserActions.find({userId: this.userId}),
        Grains.find({userId: this.userId}),
        ApiTokens.find({'owner.user.userId': this.userId}),
      ];
    } else {
      return [];
    }
  });

  Meteor.publish("sessions", function (sessionId) {
    // sessionId itself should be secret enough, but they are also not meant to be shared, so as
    // a backup we only publish the session to its owner. Note that `userId` can be null if the
    // user is not logged in or is using incognito mode.
    check(sessionId, String);
    return Sessions.find({_id: sessionId, $or: [{userId: this.userId}, {userId: null}]});
  });

  Meteor.publish("devApps", function () {
    return DevApps.find();
  });

  Meteor.publish("notifications", function () {
    return Notifications.find({userId: this.userId},
      {fields: {timestamp: 1, text: 1, grainId: 1, userId: 1, isUnread: 1}});
  });


  Meteor.publish("notificationGrains", function (notificationIds) {
    // Since publishes can't be reactive, we leave it to the client to subscribe to both
    // "notifications" and "notificationGrains" reactively.
    check(notificationIds, [String]);
    var notifications =  Notifications.find({_id: {$in: notificationIds}, userId: this.userId},
      {fields: {grainId: 1}});

    var grainIds = notifications.map(function (row) {
      return row.grainId;
    });
    return Grains.find({_id: {$in: grainIds}}, {fields: {title: 1}});
  });

  Meteor.publish("hasUsers", function () {
    // Publish pseudo-collection which tells the client if there are any users at all.
    //
    // TODO(cleanup):  This seems overcomplicated.  Does Meteor have a better way?
    var cursor = Meteor.users.find();
    var self = this;
    if (cursor.count() > 0) {
      self.added("hasUsers", "hasUsers", {hasUsers: true});
    } else {
      var handle = cursor.observeChanges({
        added: function (id) {
          self.added("hasUsers", "hasUsers", {hasUsers: true});
          handle.stop();
          handle = null;
        }
      });
      self.onStop(function () {
        if (handle) handle.stop();
      });
    }
    self.ready();
  });

  Meteor.publish("backers", function () {
    var backers = Assets.getText("backers.txt");
    var self = this;
    var anonCount = 0;
    var counter = 0;

    backers.split("\n").forEach(function (name) {
      name = name.trim();
      if (name === "") {
        ++anonCount;
      } else {
        self.added("backers", counter++, {name: name});
      }
    });

    // Text file ends in \n but that shouldn't count.
    --anonCount;

    self.added("backers", "anonymous", {count: anonCount - 1});

    self.ready();
  });
}

if (Meteor.isClient) {
  HasUsers = new Mongo.Collection("hasUsers");  // dummy collection defined above
  Backers = new Mongo.Collection("backers");  // pseudo-collection defined above

  Router.onRun(function () {
    // Close menus any time we navigate.
    globalTopbar.reset();
    this.next();
  });

  Template.layout.events({
    "click a": function (event) {
      // Close menus if a navigation link is clicked. Usually the Router.onRun(), above, will also
      // execute, but it will not in the case where the link points to the current page, yet we'd
      // really still like for the menus to close in such cases.
      if (!event.isDefaultPrevented()) {
        globalTopbar.reset();
      }
    }
  });

  Template.body.onRendered(function () {
    // If we're on iOS, set a class name on <body> so we can use CSS styles to work around mobile
    // Safari's ridiculous iframe rendering behavior.
    //
    // Note that this can't be done as a template helper because the <body> tag cannot have
    // attributes determined by helpers. This appears to be a Meteor bug related to the fact that
    // the <body> tag is not inside a <template>, but rather is itself equivalent to a <template>.
    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
      document.body.className = "ios";
    }
  });

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var formatInCountdown = function (template, countdownDatetime) {
    var days = 0;
    var hours = 0;
    var minutes = 0;
    var seconds = 0;
    var diff = countdownDatetime.getTime() - Date.now();

    var units = {
      day: 86400000,
      hour: 3600000,
      minute: 60000,
      second: 1000
    };

    for (var unit in units) {
      // If it's more than one full unit away, then we'll print in terms of this unit. This does
      // mean that we write e.g. "1 minute" for the whole range between 2 minutes and 1 minute, but
      // whatever, this is typical of these sorts of displays.
      if (diff >= units[unit]) {
        var count = Math.floor(diff / units[unit]);
        // Update next 1ms after the point where `count` would change.
        setTopBarTimeout(template, diff - count * units[unit] + 1);
        return {
          text: "in " + count + " " + unit + (count > 1 ? "s" : ""),
          className: "countdown-" + unit
        };
      }
    }

    // We're within a second of the countdown, or past it.
    if (diff < -3600000) {
      // Notification appears stale.
      return null;
    } else {
      setTopBarTimeout(template, diff + 3600001);
      return { text: "any moment", className: "countdown-now" };
    }
  };

  var formatAccountExpires = function () {
    var expires = Meteor.user().expires;
    return (expires && expires.toLocaleTimeString()) || null;
  };

  var formatAccountExpiresIn = function (template, currentDatetime) {
    // TODO(someday): formatInCountdown will set the interval to match account expiration time, and
    // completely overwrite the previous interval for $IN_COUNTDOWN
    var user = Meteor.user() || {};
    var expires = user.expires || null;
    if (!expires) {
      return null;
    } else {
      return formatInCountdown(template, expires, currentDatetime);
    }
  };

  Template.layout.onCreated(function () {
    this.timer = new Tracker.Dependency();
    this.showTopbar = new ReactiveVar(false);
    var resizeTracker = this.resizeTracker = new Tracker.Dependency();
    this.resizeFunc = function() {
      resizeTracker.changed();
    };
    window.addEventListener("resize", this.resizeFunc, false);
  });

  var setTopBarTimeout = function (template, delay) {
    Meteor.clearTimeout(template.timeout);
    template.timeout = Meteor.setTimeout(function () {
      template.timer.changed();
    }, delay);

    // Make sure we re-run when the timeout triggers.
    template.timer.depend();
  };

  Template.layout.onDestroyed(function () {
    Meteor.clearTimeout(this.timeout);
    window.removeEventListener("resize", this.resizeFunc, false);
  });

  var determineAppName = function (grainId) {
    // Returns:
    //
    // - The current app title, if we can determine it, or
    //
    // - The empty string "", if we can't determine the current app     //   title.
    var params = "";

    // Try our hardest to find the package's name, falling back on the default if needed.
    if (grainId) {
      var grain = Grains.findOne({_id: grainId});
      if (grain && grain.packageId) {
        var thisPackage = Packages.findOne({_id: grain.packageId});
        if (thisPackage) {
          params = appNameFromPackage(thisPackage);
        }
      }
    }

    return params;
  };

  Template.layout.helpers({
    showTopbar: function () {return Template.instance().showTopbar.get(); },
    adminAlertIsTooLarge: function () {
      Template.instance().resizeTracker.depend();
      var setting = Settings.findOne({_id: "adminAlert"});
      if (!setting || !setting.value) {
        return false;
      }
      // TODO(someday): 10 and 850 are just magic values that estimate the size of the font and the
      // number of pixels everything else in the topbar respectively. This should really be
      // calculated based on actual sizes of things in the topbar.
      return (window.innerWidth - setting.value.length * 10) < 850;
    },
    adminAlert: function () {
      var setting = Settings.findOne({_id: "adminAlert"});
      if (!setting || !setting.value) {
        return null;
      }
      var text = setting.value;

      var alertTimeSetting = Settings.findOne({_id: "adminAlertTime"});
      var alertTime = alertTimeSetting && alertTimeSetting.value;

      var alertUrlSetting = Settings.findOne({_id: "adminAlertUrl"});
      var alertUrl = alertUrlSetting ? alertUrlSetting.value.trim() : null;
      if (!alertUrl) alertUrl = null;

      var template = Template.instance();
      var param;
      var className;
      if (text.indexOf("$TIME") !== -1) {
        if (!alertTime) return null;
        text = text.replace("$TIME", alertTime.toLocaleTimeString());
      }
      if (text.indexOf("$DATE") !== -1) {
        if (!alertTime) return null;
        text = text.replace("$DATE", alertTime.toLocaleDateString());
      }
      if (text.indexOf("$IN_COUNTDOWN") !== -1) {
        if (!alertTime) return null;
        param = formatInCountdown(template, alertTime);
        if (!param) return null;
        text = text.replace("$IN_COUNTDOWN", param.text);
        className = param.className;
      }
      if (text.indexOf("$ACCOUNT_EXPIRES_IN") !== -1) {
        param = formatAccountExpiresIn(template);
        if (!param) return null;
        text = text.replace("$ACCOUNT_EXPIRES_IN", param.text);
        className = param.className;
      }
      if (text.indexOf("$ACCOUNT_EXPIRES") !== -1) {
        param = formatAccountExpires();
        if (!param) return null;
        text = text.replace("$ACCOUNT_EXPIRES", param);
      }
      if (text.indexOf("$APPNAME") !== -1) {
        text = text.replace("$APPNAME", determineAppName(this.grainId));
      }
      if (alertUrl && alertUrl.indexOf("$APPNAME") !== -1) {
        alertUrl = alertUrl.replace("$APPNAME", determineAppName(this.grainId));
      }
      return {text: text, className: className, alertUrl: alertUrl};
    }
  });

  Template.layout.events({
    "click #admin-alert-icon": function (event) {
      var template = Template.instance();
      template.showTopbar.set(!template.showTopbar.get());
    },
    "click #admin-alert-closer": function (event) {
      var template = Template.instance();
      template.showTopbar.set(false);
    }
  });

  Template.root.events({
    "click #logo": function (event) {
      doLogoAnimation(event.shiftKey, 0);
    }
  });

  Meteor.subscribe("credentials");

  makeDateString = function (date) {
    // Note: this is also used by grain.js.

    if (!date) {
      return "";
    }

    var result;

    var now = new Date();
    var diff = now.valueOf() - date.valueOf();

    if (diff < 86400000 && now.getDate() === date.getDate()) {
      result = date.toLocaleTimeString();
    } else {
      result = MONTHS[date.getMonth()] + " " + date.getDate() + " ";

      if (now.getFullYear() !== date.getFullYear()) {
        result = date.getFullYear() + " " + result;
      }
    }

    return result;
  };
  Template.registerHelper("dateString", makeDateString);

  Template.registerHelper("quotaEnabled", function() {
    return Meteor.settings.public.quotaEnabled;
  });

  prettySize = function (size) {
    var suffix = "B";
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
    return size.toPrecision(3) + suffix;
  }

  launchAndEnterGrainByPackageId = function(packageId) {
    var action = UserActions.findOne({packageId: packageId});
    if (!action) {
      alert("Somehow, you seem to have attempted to launch a package you have not installed.");
      return;
    } else {
      launchAndEnterGrainByActionId(action._id, null, null);
    }
  };

  launchAndEnterGrainByActionId = function(actionId, devId, devIndex) {
    // Note that this takes a devId and a devIndex as well. If provided,
    // they override the actionId.
    if (devId) {
      var devApp = DevApps.findOne(devId);
      if (!devApp) {
        console.error("no such dev app: ", devId);
        return;
      }
      var devAction = devApp.manifest.actions[devIndex];
      packageId = devApp.packageId;
      command = devAction.command;
      actionTitle = devAction.title.defaultText;
    } else {
      var action = UserActions.findOne(actionId);
      if (!action) {
        console.error("no such action: ", actionId);
        return;
      }

      packageId = action.packageId;
      command = action.command;
      actionTitle = action.title;
    }

    var title = actionTitle;
    if (title.lastIndexOf("New ", 0) === 0) {
      title = actionTitle.slice(4);
    }
    title = "Untitled " + title;

    // We need to ask the server to start a new grain, then browse to it.
    Meteor.call("newGrain", packageId, command, title, function (error, grainId) {
      if (error) {
        console.error(error);
        alert(error.message);
      } else {
        Router.go("grain", {grainId: grainId});
      }
    });
  };

  Tracker.autorun(function() {
    if (isSignedUpOrDemo()) {
      Session.set("selectedTab", {myFiles: true});
    } else {
      Session.set("selectedTab", {sharedWithMe: true});
    }
  });

  Template.root.helpers({
    filteredGrains: function () {
      var selectedTab = Session.get("selectedTab");
      var userId = Meteor.userId();
      if (selectedTab.sharedWithMe) {
        var result = [];
        var uniqueGrains = {};
        ApiTokens.find({'owner.user.userId': userId},
                       {sort:{created:1}}).forEach(function(apiToken) {
          if (!(apiToken.grainId in uniqueGrains)) {
            result.push({_id : apiToken.grainId, title: apiToken.owner.user.title});
            uniqueGrains[apiToken.grainId] = true;
          }
        });
        return result;
      } else if (selectedTab.myFiles) {
        return Grains.find({userId: userId}, {sort: {lastUsed: -1}}).fetch();
      } else {
        return Grains.find({userId: userId, appId: selectedTab.appId},
                           {sort: {lastUsed: -1}}).fetch();
      }
    },

    actions: function () {
      return UserActions.find({userId: Meteor.userId(), appId: Session.get("selectedTab").appId});
    },

    devActions: function () {
      var userId = Meteor.userId();
      if (userId) {
        var appId = Session.get("selectedTab").appId;
        if (appId) {
          var app = DevApps.findOne(appId);
          if (app && app.manifest.actions) {
            return app.manifest.actions.map(function (action, i) {
              return {
                _id: app._id,
                index: i,
                title: action.title.defaultText
              };
            });
          };
        }
      }
      return [];
    },

    selectedTab: function () {
      return Session.get("selectedTab");
    },

    selectedAppMarketingVersion: function () {
      var appMap = this.appMap;
      var app = appMap && appMap[Session.get("selectedTab").appId];
      return app && app.appMarketingVersion && app.appMarketingVersion.defaultText;
    },

    selectedAppIsDev: function () {
      var tab = Session.get("selectedTab");
      return tab && tab.appId && DevApps.findOne(tab.appId) ? true : false;
    },

    appTabClass: function (appId) {
      if (Session.get("selectedTab").appId == appId) {
        return "selected";
      } else {
        return "";
      }
    },

    splashDialog: function() {
      var setting = Settings.findOne("splashDialog");
      return (setting && setting.value) || DEFAULT_SPLASH_DIALOG;
    },

    storageUsage: function() {
      return prettySize(Meteor.user().storageUsage || 0);
    },

    storageQuota: function() {
      var quota = Meteor.user().quota;
      return (typeof quota === "number") ? prettySize(quota) : undefined;
    },

    overQuota: function() {
      return isUserOverQuota(Meteor.user());
    }
  });

  Template.root.events({
    "click .applist-tab": function (event) {
      Session.set("selectedTab", {appId: event.currentTarget.getAttribute("data-appid")});
      Session.set("showMenu", false);
    },
    "click .applist-tab-my-files": function (event) {
      Session.set("selectedTab", {myFiles: true});
      Session.set("showMenu", false);
    },
    "click .applist-tab-shared-with-me": function (event) {
      Session.set("selectedTab", {sharedWithMe: true});
      Session.set("showMenu", false);
    },
    "click .applist-tab-settings": function (event) {
      Router.go("adminSettings", {});
      Session.set("showMenu", false);
    },
    "click .applist-tab-invite": function (event) {
      Router.go("invite", {});
      Session.set("showMenu", false);
    },
    "click .applist-tab-stats": function (event) {
      Router.go("stats", {});
      Session.set("showMenu", false);
    },
    "click .applist-tab-about": function (event) {
      Router.go("about", {});
      Session.set("showMenu", false);
    },
    "click #applist-closer": function (event) {
      Session.set("showMenu", false);
    },

    "click #applist-grains tbody tr.grain": function (event) {
      Router.go("grain", {grainId: event.currentTarget.getAttribute("data-grainid")});
    },

    "click button.show-apps": function (event) {
      Session.set("showMenu", true);
    },

    "click #install-apps-button": function (event) {
      if (isUserOverQuota(Meteor.user())) {
        // The install process would eventually fail. Alert the user now rather than let them go
        // pick an app.
        alert("You are out of storage space. Please delete some things and try again.");
      } else {
        document.location = "https://sandstorm.io/apps/?host=" + getOrigin();
      }
    },

    "click #upload-app-button": function (event) {
      if (isUserOverQuota(Meteor.user())) {
        // The install process would eventually fail. Alert the user now rather than let them go
        // pick an app.
        alert("You are out of storage space. Please delete some things and try again.");
      } else {
        Router.go("uploadForm", {});
      }
    },

    "click #restore-backup-button":  function (event) {
      promptRestoreBackup();
    },

    "click .uninstall-app-button": function (event) {
      var appId = event.currentTarget.getAttribute("data-appid");
      if (window.confirm("Really uninstall this app?")) {
        UserActions.find({appId: appId, userId: Meteor.userId()}).forEach(function (action) {
          UserActions.remove(action._id);
        });
        Meteor.call("deleteUnusedPackages", appId);
        if (!Packages.findOne({appId: appId})) {
          Session.set("selectedTab", {myFiles:true});
        }
      }
    },

    "click .new-grain-button": function (event) {
      var packageId;
      var command;
      var actionTitle;

      var actionId = event.currentTarget.getAttribute("data-actionid");
      if (actionId === "dev") {
        var devId = event.currentTarget.getAttribute("data-devid");
        var devIndex = event.currentTarget.getAttribute("data-index");
      }

      launchAndEnterGrainByActionId(actionId, devId, devIndex);
    },

    "click .action-required button": function (event) {
      event.currentTarget.parentNode.parentNode.style.display = "none";
    },
  });

  Template.about.onCreated(function () {
    this.showChangelog = new ReactiveVar(false);
  });

  Template.about.helpers({
    showChangelog: function () {
      return Template.instance().showChangelog.get();
    }
  });

  Template.about.events({
    "click #show-changelog": function (ev) {
      var showChangelog = Template.instance().showChangelog;
      showChangelog.set(!showChangelog.get());
    }
  });

  Template.notificationsPopup.helpers({
    notifications: function () {
      Meteor.call("readAllNotifications");
      return Notifications.find({userId: Meteor.userId()}, {sort: {timestamp: -1}}).map(function (row) {
        var grain = Grains.findOne({_id: row.grainId});
        if (grain) {
          row.grainTitle = grain.title;
        }
        return row;
      });
    },
  });

  Template.notifications.helpers({
    notificationCount: function () {
      return Notifications.find({userId: Meteor.userId(), isUnread: true}).count();
    },
  });

  Template.notificationsPopup.events({
    "click .cancel-notification": function (event) {
      Meteor.call("dismissNotification", event.currentTarget.getAttribute("data-notificationid"));
      return false;
    },

    "click #notification-dropdown": function (event) {
      return false;
    }
  });

  Template.notifications.onCreated(function () {
    var self = this;
    this.subscribe("notifications");

    Template.instance().autorun(function () {
      if (self.grainSubscription) {
        self.grainSubscription.stop();
      }
      self.grainSubscription = self.subscribe("notificationGrains",
        Notifications.find().map(function (row) {
          return row._id;
        })
      );
    });
  });
}
Router.configure({
  layoutTemplate: 'layout',
  notFoundTemplate: "notFound",
  loadingTemplate: "loading"
});

if (Meteor.isClient) {
  Router.onBeforeAction("loading");
}

function getBuildInfo() {
  var build = Meteor.settings && Meteor.settings.public && Meteor.settings.public.build;
  var isNumber = typeof build === "number";
  if (!build) {
    build = "(unknown)";
  } else if (isNumber) {
    build = String(Math.floor(build / 1000)) + "." + String(build % 1000);
  }
  return {
    build: build,
    isUnofficial: !isNumber
  };
}

function isMissingWildcardParent() {
  return Meteor.settings && Meteor.settings.public && Meteor.settings.public.missingWildcardParentUrl;
}

appNameFromPackage = function(packageObj) {
  // This function takes a Package object from Mongo and returns an
  // app title.
  var manifest = packageObj.manifest;
  var action = manifest.actions[0];
  appName = (manifest.appTitle && manifest.appTitle.defaultText) ||
    appNameFromActionName(action.title.defaultText);
  return appName;
}

appNameFromActionName = function(name) {
  // Hack: Historically we only had action titles, like "New Etherpad Document", not app
  //   titles. But for this UI we want app titles. As a transitionary measure, try to
  //   derive the app title from the action title.
  // TODO(cleanup): Get rid of this once apps have real titles.
  if (!name) {
    return "(unnamed)";
  }
  if (name.lastIndexOf("New ", 0) === 0) {
    name = name.slice(4);
  }
  if (name.lastIndexOf("Hacker CMS", 0) === 0) {
    name = "Hacker CMS";
  } else {
    var space = name.indexOf(" ");
    if (space > 0) {
      name = name.slice(0, space);
    }
  }
  return name;
}

promptRestoreBackup = function() {
  // TODO(cleanup): Share code with "upload picture" and other upload buttons.
  var input = document.createElement("input");
  input.type = "file";
  input.style = "display: none";
  Session.set("uploadStatus", "Uploading");

  input.addEventListener("change", function (e) {
    // TODO(cleanup): Use Meteor's HTTP, although this may require sending them a PR to support
    //   progress callbacks (and officially document that binary input is accepted).
    var file = e.currentTarget.files[0];

    var xhr = new XMLHttpRequest();

    xhr.onreadystatechange = function () {
      if (xhr.readyState == 4) {
        if (xhr.status == 200) {
          Session.set("uploadProgress", 0);
          Session.set("uploadStatus", "Unpacking");
          Meteor.call("restoreGrain", xhr.responseText, function (err, grainId) {
            if (err) {
              Session.set("uploadStatus", undefined);
              Session.set("uploadError", {
                status: 200,
                statusText: err.reason + ": " + err.details,
              });
            } else {
              Router.go("grain", {grainId: grainId});
            }
          });
        } else {
          Session.set("uploadError", {
            status: xhr.status,
            statusText: xhr.statusText,
            response: xhr.responseText
          });
        }
      }
    };

    if (xhr.upload) {
      xhr.upload.addEventListener("progress", function (progressEvent) {
        Session.set("uploadProgress",
            Math.floor(progressEvent.loaded / progressEvent.total * 100));
      });
    }

    xhr.open("POST", "/uploadBackup", true);
    xhr.send(file);

    Router.go("restoreGrainStatus");
  });

  input.click();
}

Router.map(function () {
  this.route("root", {
    path: "/",
    waitOn: function () {
      return [
        Meteor.subscribe("credentials"),
        Meteor.subscribe("hasUsers"),
        Meteor.subscribe("grainsMenu"),
        Meteor.subscribe("devApps")
      ];
    },
    data: function () {
      if (!this.ready()) {
        return;
      }

      var apps;
      var appMap = {};
      var allowDemoAccounts = Meteor.settings && Meteor.settings.public &&
            Meteor.settings.public.allowDemoAccounts;
      var userId = Meteor.userId();
      if (userId) {
        var appNames = [];

        DevApps.find().forEach(function (app) {
          var action = app.manifest && app.manifest.actions && app.manifest.actions[0];
          var name = (app.manifest.appTitle && app.manifest.appTitle.defaultText) ||
              appNameFromActionName(action && action.title && action.title.defaultText);
          appMap[app._id] = {
            name: name,
            appId: app._id,
            isDev: true,
            appMarketingVersion: app.manifest.appMarketingVersion
          };
          appNames.push({name: name, appId: app._id});
        });

        UserActions.find({userId: userId}).forEach(function (action) {
          if (!(action.appId in appMap)) {
            var name = action.appTitle || appNameFromActionName(action.title);
            appMap[action.appId] = {
              name: name,
              appId: action.appId,
              appMarketingVersion: action.appMarketingVersion
            };
            appNames.push({name: name, appId: action.appId});
          }
        });

        appNames.sort(function (a, b) { return a.name.localeCompare(b.name); });
        apps = appNames.map(function (appName) {
          return appMap[appName.appId];
        });
      } else if (allowDemoAccounts) {
        Meteor.setTimeout(function () { Router.go("demo", {}, {replaceState: true}); }, 0);
      }

      return {
        host: document.location.host,
        origin: getOrigin(),
        isSignedUpOrDemo: isSignedUpOrDemo(),
        isAdmin: isAdmin(),
        isDemoUser: isDemoUser(),
        isFirstRun: !HasUsers.findOne("hasUsers"),
        build: getBuildInfo().build,
        missingWildcardParent: isMissingWildcardParent(),
        allowDemoAccounts: allowDemoAccounts,
        apps: apps,
        showMenu: Session.get("showMenu"),
        appMap: appMap,
        hideSplashScreen: isSignedUpOrDemo() ||
          ApiTokens.findOne({"owner.user.userId": Meteor.userId()})
      };
    }
  });

  this.route("linkHandler", {
    path: "/link-handler/:url",

    data: function () {
      var url = this.params.url;
      if (url.lastIndexOf("web+sandstorm:", 0) === 0) {
        url = url.slice("web+sandstorm:".length);
      }
      // TODO(cleanup):  Didn't use Router.go() because the url may contain a query term.
      document.location = "/install/" + url;
      return {};
    }
  });

  this.route("about", {
    path: "/about",
    data: function () {
      var result = getBuildInfo();

      var backers = Session.get("backers");
      if (backers) {
        result.backers = backers.names;
        result.anonCount = backers.anonCount;
      } else {
        HTTP.get("/sandstorm-backers.txt", function (err, response) {
          var names = response.content.split("\n").sort(function (a, b) {
            return a.toLowerCase().localeCompare(b.toLowerCase());
          });

          var anonCount = 0;
          while (anonCount < names.length && names[anonCount] === "") {
            ++anonCount;
          }
          names = names.slice(anonCount);

          // File ends in trailing newline, but that last blank line does not represent an
          // anonymous contributor.
          --anonCount;

          Session.set("backers", {names: names, anonCount: anonCount});
        });
      }

      return result;
    }
  });

  this.route("restoreGrainStatus", {
    path: "/restore",

    waitOn: function () {
      return Meteor.subscribe("credentials");
    },

    data: function () {
      return {
        progress: Session.get("uploadProgress"),
        status: Session.get("uploadStatus"),
        error: Session.get("uploadError")
      };
    }
  });

  this.route("account", {
    path: "/account",

    data: function () {
      if (!Meteor.userId()) {
        // Not logged in.
        Router.go("root");
      }
      return new SandstormAccountSettingsUi(globalTopbar,
          window.location.protocol + "//" + makeWildcardHost("static"));
    }
  });
});
