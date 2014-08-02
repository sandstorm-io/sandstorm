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
  Meteor.publish("grainsMenu", function () {
    if (this.userId) {
      return [
        UserActions.find({userId: this.userId}),
        Grains.find({userId: this.userId})
      ];
    } else {
      return [];
    }
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
}

if (Meteor.isClient) {
  HasUsers = new Meteor.Collection("hasUsers");  // dummy collection defined above

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

  Deps.autorun(function () {
    Meteor.subscribe("credentials");
  });

  Template.root.helpers({
    filteredGrains: function () {
      var selectedApp = Session.get("selectedApp");
      var userId = Meteor.userId();
      if (selectedApp) {
        return Grains.find({userId: userId, appId: selectedApp}, {sort: {lastUsed: -1}}).fetch();
      } else {
        return Grains.find({userId: userId}, {sort: {lastUsed: -1}}).fetch();
      }
    },

    actions: function () {
      return UserActions.find({userId: Meteor.userId(), appId: Session.get("selectedApp")});
    },

    devActions: function () {
      var userId = Meteor.userId();
      if (userId) {
        var appId = Session.get("selectedApp");
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

    selectedApp: function () {
      return Session.get("selectedApp");
    },

    selectedAppIsDev: function () {
      var app = Session.get("selectedApp");
      return app && DevApps.findOne(app) ? true : false;
    },

    tabClass: function (appId) {
      if (Session.get("selectedApp") == appId) {
        return "selected";
      } else {
        return "";
      }
    },

    dateString: function (date) {
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
    }
  });

  Template.root.events({
    "click .applist-tab": function (event) {
      Session.set("selectedApp", event.currentTarget.getAttribute("data-appid"));
    },
    "click .applist-tab-invite": function (event) {
      Router.go("invite", {});
    },
    "click .applist-tab-stats": function (event) {
      Router.go("stats", {});
    },
    "click .applist-tab-about": function (event) {
      Router.go("about", {});
    },

    "click #applist-grains tbody tr": function (event) {
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

    "click .new-grain-button": function (event) {
      var packageId;
      var command;
      var actionTitle;

      var actionId = event.currentTarget.getAttribute("data-actionid");
      if (actionId === "dev") {
        var devId = event.currentTarget.getAttribute("data-devid");
        var devIndex = event.currentTarget.getAttribute("data-index");
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
        } else {
          Router.go("grain", {grainId: grainId});
        }
      });
    },

    "click .action-required button": function (event) {
      event.currentTarget.parentNode.parentNode.style.display = "none";
    },
  });

  Template.homeLink.events({
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

function appNameFromActionName(name) {
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
      var apps;
      var allowDemoAccounts = Meteor.settings && Meteor.settings.public &&
            Meteor.settings.public.allowDemoAccounts;
      if (isSignedUpOrDemo()) {
        var userId = Meteor.userId();

        var appMap = {};
        var appNames = [];

        DevApps.find().forEach(function (app) {
          var action = app.manifest && app.manifest.actions && app.manifest.actions[0];
          var name = appNameFromActionName(action && action.title && action.title.defaultText);
          appMap[app._id] = {
            name: name,
            appId: app._id,
            isDev: true
          };
          appNames.push({name: name, appId: app._id});
        });

        UserActions.find({userId: userId}).forEach(function (action) {
          if (!(action.appId in appMap)) {
            var name = appNameFromActionName(action.title);
            appMap[action.appId] = {
              name: name,
              appId: action.appId
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
        isSignedUp: isSignedUpOrDemo(),
        isAdmin: isAdmin(),
        isDemoUser: isDemoUser(),
        isFirstRun: !HasUsers.findOne("hasUsers"),
        build: getBuildInfo().build,
        kernelTooOld: isKernelTooOld(),
        missingWildcardParent: isMissingWildcardParent(),
        allowDemoAccounts: allowDemoAccounts,
        apps: apps
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
      return getBuildInfo();
    }
  });

  this.route("restoreGrainStatus", {
    path: "/restore",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
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
