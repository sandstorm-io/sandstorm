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

getOrigin = function() {
  return document.location.protocol + "//" + document.location.host;
}

if (Meteor.isServer) {
  // Set up browser policy.
  //
  // Note that by default (when the browser-policy package is added), Content-Security-Policy will
  // already be set to same-origin-only for everything except XHR and WebSocket. Eval is disabled,
  // but inline script are enabled.
  //
  // TODO(security): Consider disallowing inline scripts. Currently this forces Meteor to do an
  //   extra round trip on startup to fetch server settings. That seams like something that could
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

  Meteor.publish("grainsMenu", function () {
    if (this.userId) {
      return [
        UserActions.find({userId: this.userId}),
        Grains.find({userId: this.userId}),
        RoleAssignments.find({recipient: this.userId}),
      ];
    } else {
      return [];
    }
  });

  Meteor.publish("sessions", function (sessionId) {
    // sessionId itself should be secret enough, but they are also not meant to be shared, so as
    // a backup we only publish the session to its owner. Note that `userId` can be null if the
    // user is not logged in.
    return Sessions.find({_id: sessionId, userId: this.userId});
  });

  Meteor.publish("devApps", function () {
    return DevApps.find();
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

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  Template.topBar.helpers({
    isUpdateBlocked: function () { return isUpdateBlocked(); }
  });
  Template.topBar.events({
    "click #topbar-update": function (event) {
      unblockUpdate();
    }
  });

  Template.root.events({
    "click #logo": function (event) {
      doLogoAnimation(event.shiftKey, 0);
    }
  });

  Tracker.autorun(function () {
    Meteor.subscribe("credentials");
  });

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
        RoleAssignments.find({}, {sort:{created:1}}).forEach(function(roleAssignment) {
          if (!(roleAssignment.grainId in uniqueGrains)) {
            result.push({_id : roleAssignment.grainId, title: roleAssignment.title});
            uniqueGrains[roleAssignment.grainId] = true;
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

    dateString: function (date) { return makeDateString(date); },

    splashDialog: function() {
      var setting = Settings.findOne("splashDialog");
      return (setting && setting.value) || DEFAULT_SPLASH_DIALOG;
    },

    userId: function () {
      return Meteor.userId();
    },
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
      Router.go("admin", {});
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

    "click #install-apps-button": function (event) {
      document.location = "https://sandstorm.io/apps/?host=" + getOrigin();
    },

    "click #upload-app-button": function (event) {
      Router.go("uploadForm", {});
    },

    "click #restore-backup-button":  function (event) {
      var grainId = this.grainId;

      var input = document.createElement("input");
      input.type = "file";
      input.style = "display: none";
      Session.set("uploadStatus", "Uploading");

      input.addEventListener("change", function (e) {
        // TODO: make sure only 1 file is uploaded
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

  Template.homeLink.events({
    "click #menu-button": function (event) {
      Session.set("showMenu", !Session.get("showMenu"));
    },

    "click #homelink": function (event) {
      event.preventDefault();
      Router.go("root", {});
    }
  });
  Template.homeLink.helpers({
    origin: getOrigin
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

function isKernelTooOld() {
  return Meteor.settings && Meteor.settings.public && Meteor.settings.public.kernelTooOld;
}

function isMissingWildcardParent() {
  return Meteor.settings && Meteor.settings.public && Meteor.settings.public.missingWildcardParentUrl;
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
        kernelTooOld: isKernelTooOld(),
        missingWildcardParent: isMissingWildcardParent(),
        allowDemoAccounts: allowDemoAccounts,
        apps: apps,
        showMenu: Session.get("showMenu"),
        appMap: appMap
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

      console.log(result);
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
});
