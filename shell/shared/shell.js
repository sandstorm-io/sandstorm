// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// This file is part of the Sandstorm platform implementation.
//
// Sandstorm is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Sandstorm is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public
// License along with Sandstorm.  If not, see
// <http://www.gnu.org/licenses/>.

// This file implements the common shell components such as the top bar.
// It also covers the root page.

browseHome = function() {
  Router.go("root");
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
    Meteor.subscribe("grainsMenu");
    Meteor.subscribe("devApps");
    Meteor.subscribe("credentials");
  });

  Template.grainList.events({
    "click #apps-ico": function (event) {
      Session.set("grainMenuOpen", true);
    },

    "click #close-apps": function (event) {
      Session.set("grainMenuOpen", false);
    },

    "click .newGrain": function (event) {
      var packageId;
      var command;

      var parts = event.currentTarget.id.split("-");
      if (parts[1] === "dev") {
        var devId = parts[2];
        var devApp = DevApps.findOne(devId);
        if (!devApp) {
          console.error("no such dev app: ", devId);
          return;
        }

        var devAction = devApp.manifest.actions[parts[3]];

        packageId = devApp.packageId;
        command = devAction.command;
      } else {
        var id = parts[1];
        var action = UserActions.findOne(id);
        if (!action) {
          console.error("no such action: ", id);
          return;
        }

        packageId = action.packageId;
        command = action.command;
      }

      Session.set("grainMenuOpen", false);
      var title = window.prompt("Title?");
      if (!title) return;

      // We need to ask the server to start a new grain, then browse to it.
      Meteor.call("newGrain", packageId, command, title, function (error, grainId) {
        if (error) {
          console.error(error);
        } else {
          Router.go("grain", {grainId: grainId});
        }
      });
    },

    "click .openGrain": function (event) {
      var grainId = event.currentTarget.id.split("-")[1];
      Session.set("grainMenuOpen", false);
      Router.go("grain", {grainId: grainId});
    },

    "click #installAppsLink": function (event) {
      document.location = "https://sandstorm.io/apps/?host=" + document.location.origin;
    },

    "click #uploadAppLink": function (event) {
      Session.set("grainMenuOpen", false);
      Router.go("uploadForm", {});
    },

    "click #restoreGrainLink":  function (event) {
      var grainId = this.grainId;

      var input = document.createElement("input");
      input.type = "file";
      input.style = "display: none";

      input.addEventListener("change", function (e) {
        // TODO: make sure only 1 file is uploaded
        var file = e.currentTarget.files[0];

        var xhr = new XMLHttpRequest();

        xhr.onreadystatechange = function () {
          if (xhr.readyState == 4) {
            Session.set("uploadProgress", undefined);
            if (xhr.status == 200) {
              Meteor.call('restoreGrain', xhr.responseText, function(err, grainId) {
                // TODO: show user error
                Router.go('grain', {grainId: grainId});
              });
            } else {
              // TODO: show user error
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

        Router.go('restoreGrainStatus');
      });

      input.click();
    },

    "click #emailInvitesLink": function (event) {
      Session.set("grainMenuOpen", false);
      Router.go("invite", {});
    },

    "click #urlInvitesLink": function (event) {
      Session.set("grainMenuOpen", false);
      Router.go("signupMint", {});
    },

    "click #aboutLink": function (event) {
      Session.set("grainMenuOpen", false);
      Router.go("about", {});
    }
  });

  Template.grainList.helpers({
    grains: function () {
      var userId = Meteor.userId();
      if (userId) {
        return Grains.find({userId: userId}, {sort: {lastUsed: -1}}).fetch();
      } else {
        return [];
      }
    },
    actions: function () {
      var userId = Meteor.userId();
      if (userId) {
        return UserActions.find({userId: userId}).fetch();
      } else {
        return [];
      }
    },
    devActions: function () {
      var userId = Meteor.userId();
      if (userId) {
        var result = [];
        DevApps.find().forEach(function (app) {
          if (app.manifest.actions) {
            app.manifest.actions.forEach(function (action, i) {
              result.push({
                _id: app._id,
                index: i,
                title: action.title.defaultText
              });
            });
          }
        });
        return result;
      } else {
        return [];
      }
    },
    menuOpen: function () {
      return Session.get("grainMenuOpen");
    },
    isAdmin: isAdmin
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

Router.map(function () {
  this.route("root", {
    path: "/",
    waitOn: function () {
      return [ Meteor.subscribe("credentials"), Meteor.subscribe("hasUsers") ];
    },
    onAfterAction: function () { setTimeout(initLogoAnimation, 0); },
    data: function () {
      return {
        host: document.location.host,
        origin: document.location.origin,
        isSignedUp: isSignedUp(),
        isAdmin: isAdmin(),
        isFirstRun: !HasUsers.findOne("hasUsers"),
        build: getBuildInfo().build,
        kernelTooOld: isKernelTooOld()
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
        isSignedUp: isSignedUp(),
        progress: Session.get("uploadProgress"),
        error: Session.get("uploadError")
      };
    }
  });
});
