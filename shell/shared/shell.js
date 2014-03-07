// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
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

Apps = new Meteor.Collection("apps");
UserActions = new Meteor.Collection("userActions");
Grains = new Meteor.Collection("grains");
Sessions = new Meteor.Collection("sessions");
SignupKeys = new Meteor.Collection("signupKeys");

function isSignedUp() {
  var user = Meteor.user();
  if (user && user.signupKey) {
    return true;
  } else {
    return false;
  }
}

function isAdmin() {
  var user = Meteor.user();
  if (user && user.isAdmin) {
    return true;
  } else {
    return false;
  }
}

if (Meteor.isClient) {
  var url = document.location.origin + "/link-handler/%s";
  // TODO(soon):  Once the handler is installed on Firefox, it insists on showing a butterbar again
  //   on every load to remind the user that it is already installed, but
  //   isProtocolHandlerRegistered() is not implemented so there's no way to avoid it!  Argh!
  navigator.registerProtocolHandler("web+sandstorm", url, "Sandstorm");
}

if (Meteor.isServer) {
  Apps.allow({
    remove: function (userId, app) {
      // Failed downloads can be removed and restarted.
      return app.status === "failed";
    }
  });

  UserActions.allow({
    insert: function (userId, action) {
      return userId && isSignedUp() && action.userId === userId;
    }
  });

  Meteor.publish("apps", function (appId) {
    return Apps.find(appId);
  });

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

  Meteor.publish("credentials", function () {
    if (this.userId) {
      return Meteor.users.find({_id: this.userId}, {fields: {signupKey: 1, isAdmin: 1}});
    } else {
      return [];
    }
  });

  Meteor.publish("signupKey", function (key) {
    return SignupKeys.find(key);
  });

  Meteor.methods({
    useSignupKey: function (key) {
      if (!this.userId) {
        throw new Meteor.Error(403, "Must be signed in.");
      }

      if (isSignedUp()) {
        // Don't waste it.
        return;
      }

      var keyInfo = SignupKeys.find(key);
      if (!keyInfo || keyInfo.used) {
        throw new Meteor.Error(403, "Invalid key or already used.");
      }

      Meteor.users.update(this.userId, {$set: {signupKey: key}});
      SignupKeys.update(key, {$set: {used: true}});
    },

    createSignupKey: function (note) {
      if (!isAdmin()) {
        throw new Meteor.Error(403, "Must be admin to create keys.");
      }

      var key = Random.id();
      SignupKeys.insert({_id: key, used: false, note: note});
      return key;
    }
  });
}

Meteor.methods({
  ensureInstalled: function (appId, url) {
    if (!this.userId) {
      throw new Meteor.Error(403, "Unauthorized", "You must be logged in to install apps.");
    }

    if (!isSignedUp()) {
      throw new Meteor.Error(403, "Unauthorized",
          "Sorry, Sandstorm is in closed alpha.  You must receive an alpha key before you " +
          "can install apps.");
    }

    var app = Apps.findOne(appId);
    if (app) {
      if (app.status === "ready" || app.status === "failed") {
        // Don't try to install.
        return;
      }
    } else {
      Apps.insert({ _id: appId, status: "download", progress: 0 });
    }

    // Start installing on the server side if we aren't already.
    if (!this.isSimulation) {
      startInstall(appId, url);
    }
  }
});

if (Meteor.isServer) {
  var Fs = Npm.require("fs");
  var Path = Npm.require("path");
  var GRAINDIR = "/var/sandstorm/grains";

  Meteor.methods({
    cancelDownload: function (appId) {
      // TODO(security):  Only let user cancel download if they initiated it.
      cancelDownload(appId);
    }
  });
}

if (Meteor.isClient) {
  Template.root.events({
    "click #logo": function (event) {
      doLogoAnimation(event.shiftKey, 0);
    }
  });

  Template.grain.preserve(["iframe"]);

  Meteor.subscribe("grainsMenu");

  Template.grainList.events({
    "click #apps-ico": function (event) {
      var ico = event.currentTarget;
      var pop = document.getElementById("apps");
      if (pop.style.display === "block") {
        pop.style.display = "none";
      } else {
        var rec = ico.getBoundingClientRect();
        pop.style.left = rec.left + "px";
        pop.style.top = rec.bottom + 16 + "px";
        pop.style.display = "block";

        var left = rec.left - Math.floor((pop.clientWidth - rec.width) / 2);
        if (left < 8) {
          left = 8;
        } else if (left + pop.clientWidth > window.innerWidth) {
          left = window.innerWidth - pop.clientWidth - 8;
        }

        pop.style.left = left + "px";
      }
    },

    "click .newGrain": function (event) {
      var id = event.currentTarget.id.split("-")[1];
      var action = UserActions.findOne(id);
      if (!action) {
        console.error("no such action: ", id);
        return;
      }

      document.getElementById("apps").style.display = "none";
      var title = window.prompt("Title?");
      if (!title) return;

      // We need to ask the server to start a new grain, then browse to it.
      Meteor.call("newGrain", action.appId, action.command, title, function (error, grainId) {
        if (error) {
          console.error(error);
        } else {
          Router.go("grain", {grainId: grainId});
        }
      });
    },

    "click .openGrain": function (event) {
      var grainId = event.currentTarget.id.split("-")[1];
      document.getElementById("apps").style.display = "none";
      Router.go("grain", {grainId: grainId});
    }
  });

  Template.grainList.helpers({
    grains: function () {
      var userId = Meteor.userId();
      if (userId) {
        return Grains.find({userId: userId}).fetch();
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
    }
  });

  Template.install.events({
    "click #retry": function (event) {
      Apps.remove(this.appId);
    },

    "click #cancelDownload": function (event) {
      Meteor.call("cancelDownload", this.appId);
    },

    "click #confirmInstall": function (event) {
      var app = Apps.findOne(this.appId);
      if (app) {
        var actions = app.manifest.actions;
        for (i in actions) {
          var action = actions[i];
          if ("none" in action.input) {
            UserActions.insert({
              userId: Meteor.userId(),
              appId: app._id,
              title: action.title.defaultText,
              command: action.command
            });
          } else {
            // TODO(someday):  Implement actions with capability inputs.
          }
        }
      }
    }
  });

  Template.signupMint.events({
    "click #create": function (event) {
      var note = document.getElementById("key-note").value;

      Meteor.call("createSignupKey", note, function (error, key) {
        if (error) {
          Session.set("signupMintMessage", { error: error.toString() });
        } else {
          Session.set("signupMintMessage", {
            url: document.location.origin + Router.routes.signup.path({key: key})
          });
        }
      });
    },

    "click #retry": function (event) {
      Session.set("signupMintMessage", undefined);
    },
  });
}

if (Meteor.isClient) {
  // Send keep-alive every now and then.
  var currentSessionId;
  Meteor.setInterval(function () {
    if (currentSessionId) {
      // TODO(soon):  Investigate what happens in background tabs.  Maybe arrange to re-open the
      //   app if it dies while in the background.
      console.log("keepalive: ", new Date());
      Meteor.call("keepSessionAlive", currentSessionId);
    }
  }, 60000);
}

Router.map(function () {
  this.route("root", {
    path: "/",
    after: function () { setTimeout(initLogoAnimation, 0); },
    data: function () {
      return { host: document.location.host };
    }
  });

  this.route("grain", {
    path: "/grain/:grainId",

    data: function () {
      currentSessionId = undefined;
      var grainId = this.params.grainId;
      var err = Session.get("session-" + grainId + "-error");
      if (err) {
        return { error: err };
      }

      var session = Session.get("session-" + grainId);
      if (session) {
        currentSessionId = session.sessionId;
        return _.extend({ hostname: document.location.hostname }, session);
      } else {
        Meteor.call("openSession", grainId, function (error, session) {
          if (error) {
            Session.set("session-" + grainId + "-error", error.message);
          } else {
            Session.set("session-" + grainId, session);
            Session.set("session-" + grainId + "-error", undefined);
          }
        });
        return {};
      }
    },

    unload: function () {
      currentSessionId = undefined;
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

  this.route("install", {
    path: "/install/:appId",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
      return [
        Meteor.subscribe("apps", this.params.appId),
        Meteor.subscribe("credentials")
      ];
    },

    data: function () {
      var userId = Meteor.userId();
      if (!userId) {
        return { error: "You must sign in to install apps.", appId: this.params.appId };
      }
      if (!isSignedUp()) {
        return { error: "Sorry, Sandstorm is in closed alpha.  You must receive an alpha " +
                        "key before you can install apps.", appId: this.params.appId };
      }

      if (this.params.url) {
        Meteor.call("ensureInstalled", this.params.appId, this.params.url);
      }

      var app = Apps.findOne(this.params.appId);
      if (app === undefined) {
        // Apparently, this app is not installed nor installing, which implies that no URL was
        // provided, which means we cannot install it.
        // TODO(soon):  Display upload page?
        return { error: "Unknown app ID: " + this.params.appId +
                        "\nPerhaps it hasn't been uploaded?",
                 appId: this.params.appId };
      }

      if (app.status !== "ready") {
        var progress;
        if (app.progress < 0) {
          progress = "";  // -1 means no progress to report
        } else if (app.progress > 1) {
          // Progress outside [0,1] indicates a byte count rather than a fraction.
          // TODO(cleanup):  This is pretty ugly.  What if exactly 1 byte had been downloaded?
          progress = Math.round(app.progress / 1024) + " KiB";
        } else {
          progress = Math.round(app.progress * 100) + "%";
        }

        return {
          step: app.status,
          progress: progress,
          error: app.status === "failed" ? app.error : null,
          appId: this.params.appId
        };
      }

      if (UserActions.findOne({ userId: Meteor.userId(), appId: this.params.appId })) {
        // This app appears to be installed already.
        return { step: "run", appId: this.params.appId };
      } else {
        return { step: "confirm", appId: this.params.appId };
      }
    }
  });

  this.route("signup", {
    path: "/signup/:key",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
      return [
        Meteor.subscribe("signupKey", this.params.key),
        Meteor.subscribe("credentials")
      ];
    },

    data: function () {
      var keyInfo = SignupKeys.findOne(this.params.key);

      var result = {
        keyIsValid: !!keyInfo,
        keyIsUsed: keyInfo && keyInfo.used,
        alreadySignedUp: isSignedUp()
      };

      if (result.alreadySignedUp) {
        Router.go("root");
      } else if (result.keyIsValid && !result.keyIsUsed && Meteor.userId()) {
        Meteor.call("useSignupKey", this.params.key);
      }

      return result;
    }
  });

  this.route("signupMint", {
    path: "/signup-mint",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
      return Meteor.subscribe("credentials");
    },

    data: function () {
      return Session.get("signupMintMessage") || {};
    }
  });
});
