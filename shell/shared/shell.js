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

Packages = new Meteor.Collection("packages");
// Packages which are installed or downloadloading.
//
// Each contains:
//   _id:  128-bit prefix of SHA-256 hash of spk file, hex-encoded.
//   status:  String.  One of "download", "verify", "unpack", "analyze", "ready", "failed"
//   progress:  Float.  -1 = N/A, 0-1 = fractional progress (e.g. download percentage),
//       >1 = download byte count.
//   error:  If status is "failed", error message string.
//   manifest:  If status is "ready", the package manifest.  See "Manifest" in grain.capnp.
//   appId:  If status is "ready", the application ID string.  Packages representing different
//       versions of the same app have the same appId.  The spk tool defines the app ID format
//       and can cryptographically verify that a package belongs to a particular app ID.

UserActions = new Meteor.Collection("userActions");
// List of actions that each user has installed which create new grains.  Each app may install
// some number of actions (usually, one).
//
// Each contains:
//   _id:  random
//   userId:  User who has installed this action.
//   packageId:  Package used to run this action.
//   appId:  Same as Packages.findOne(packageId).appId; denormalized for searchability.
//   appVersion:  Same as Packages.findOne(packageId).manifest.appVersion; denormalized for
//       searchability.
//   title:  Human-readable title for this action, e.g. "New Spreadsheet".
//   command:  Manifest.Command to run this action (see package.capnp).

Grains = new Meteor.Collection("grains");
// Grains belonging to users.
//
// Each contains:
//   _id:  random
//   packageId:  _id of the package of which this grain is an instance.
//   appId:  Same as Packages.findOne(packageId).appId; denormalized for searchability.
//   appVersion:  Same as Packages.findOne(packageId).manifest.appVersion; denormalized for
//       searchability.
//   userId:  User who owns this grain.
//   title:  Human-readable string title, as chosen by the user.

Sessions = new Meteor.Collection("sessions");
// UI sessions open to particular grains.  A new session is created each time a user opens a grain.
//
// Each contains:
//   _id:  random
//   grainId:  _id of the grain to which this session is connected.
//   port:  TCP port number on which this session is being exported.
//   timestamp:  Time of last keep-alive message to this session.  Sessions time out after some
//       period.

SignupKeys = new Meteor.Collection("signupKeys");
// Invite keys which may be used by users to get access to Sandstorm.
//
// Each contains:
//   _id:  random
//   used:  Boolean indicating whether this key has already been consumed.
//   note:  Text note assigned when creating key, to keep track of e.g. whom the key was for.

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
  UserActions.allow({
    insert: function (userId, action) {
      return userId && isSignedUp() && action.userId === userId;
    },
    remove: function (userId, action) {
      return userId && action.userId === userId;
    }
  });

  Meteor.publish("packageInfo", function (packageId) {
    var packageCursor = Packages.find(packageId);
    var package = packageCursor.fetch()[0];

    if (package && this.userId) {
      // TODO(perf):  Grain list could be large.  In theory all we really need is to know whether
      //   grains of newer and older versions exist.
      return [
        packageCursor,
        UserActions.find({ userId: this.userId, appId: package.appId }),
        Grains.find({ userId: this.userId, appId: package.appId })
      ];
    } else {
      return packageCursor;
    }
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
  ensureInstalled: function (packageId, url) {
    if (!this.userId) {
      throw new Meteor.Error(403, "Unauthorized", "You must be logged in to install packages.");
    }

    if (!isSignedUp()) {
      throw new Meteor.Error(403, "Unauthorized",
          "Sorry, Sandstorm is in closed alpha.  You must receive an alpha key before you " +
          "can install packages.");
    }

    var app = Packages.findOne(packageId);
    if (app) {
      if (app.status === "ready" || app.status === "failed") {
        // Don't try to install.
        return;
      }
    } else {
      Packages.insert({ _id: packageId, status: "download", progress: 0 });
    }

    // Start installing on the server side if we aren't already.
    if (!this.isSimulation) {
      startInstall(packageId, url);
    }
  },

  retryInstall: function (packageId) {
    if (!this.userId) {
      throw new Meteor.Error(403, "Unauthorized", "You must be logged in to install packages.");
    }

    if (!isSignedUp()) {
      throw new Meteor.Error(403, "Unauthorized",
          "Sorry, Sandstorm is in closed alpha.  You must receive an alpha key before you " +
          "can install packages.");
    }

    var pkg = Packages.findOne(packageId);
    var appId = undefined;
    if (pkg) {
      if (pkg.status !== "failed") {
        throw new Meteor.Error(403, "Unauthorized",
            "Can't retry an install that hasn't failed.");
      }
      appId = pkg.appId;
      Packages.update(packageId, {$set: {status: "download", progress: 0 }});
    } else {
      Packages.insert({ _id: packageId, status: "download", progress: 0 });
    }

    // Start installing on the server side if we aren't already.
    if (!this.isSimulation) {
      startInstall(packageId, url, appId);
    }
  },

  upgradeGrains: function (appId, version, packageId) {
    var selector = {
      userId: this.userId,
      appId: appId,
      appVersion: { $lte: version },
      packageId: { $ne: packageId }
    };

    if (!this.isSimulation) {
      Grains.find(selector).forEach(function (grain) {
        shutdownGrain(grain);
      });
    }

    Grains.update(selector, { $set: { appVersion: version, packageId: packageId }});
  }
});

if (Meteor.isServer) {
  var Fs = Npm.require("fs");
  var Path = Npm.require("path");
  var GRAINDIR = "/var/sandstorm/grains";

  Meteor.methods({
    cancelDownload: function (packageId) {
      // TODO(security):  Only let user cancel download if they initiated it.
      cancelDownload(packageId);
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
      Meteor.call("newGrain", action.packageId, action.command, title, function (error, grainId) {
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
      Meteor.call("retryInstall", this.packageId);
    },

    "click #cancelDownload": function (event) {
      Meteor.call("cancelDownload", this.packageId);
    },

    "click #confirmInstall": function (event) {
      var package = Packages.findOne(this.packageId);
      if (package) {
        // Remove old versions.
        UserActions.find({userId: Meteor.userId(), appId: package.appId})
            .forEach(function (action) {
          UserActions.remove(action._id);
        });

        // Install new.
        var actions = package.manifest.actions;
        for (i in actions) {
          var action = actions[i];
          if ("none" in action.input) {
            UserActions.insert({
              userId: Meteor.userId(),
              packageId: package._id,
              appId: package.appId,
              appVersion: package.manifest.appVersion,
              title: action.title.defaultText,
              command: action.command
            });
          } else {
            // TODO(someday):  Implement actions with capability inputs.
          }
        }
      }
    },

    "click #upgradeGrains": function (event) {
      Meteor.call("upgradeGrains", this.appId, this.version, this.packageId);
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
    path: "/install/:packageId",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
      return [
        Meteor.subscribe("packageInfo", this.params.packageId),
        Meteor.subscribe("credentials")
      ];
    },

    data: function () {
      var userId = Meteor.userId();
      if (!userId) {
        return { error: "You must sign in to install packages.", packageId: this.params.packageId };
      }
      if (!isSignedUp()) {
        return { error: "Sorry, Sandstorm is in closed alpha.  You must receive an alpha " +
                        "key before you can install packages.", packageId: this.params.packageId };
      }

      if (this.params.url) {
        Meteor.call("ensureInstalled", this.params.packageId, this.params.url);
      }

      var package = Packages.findOne(this.params.packageId);
      if (package === undefined) {
        // Apparently, this app is not installed nor installing, which implies that no URL was
        // provided, which means we cannot install it.
        // TODO(soon):  Display upload page?
        return { error: "Unknown package ID: " + this.params.packageId +
                        "\nPerhaps it hasn't been uploaded?",
                 packageId: this.params.packageId };
      }

      if (package.status !== "ready") {
        var progress;
        if (package.progress < 0) {
          progress = "";  // -1 means no progress to report
        } else if (package.progress > 1) {
          // Progress outside [0,1] indicates a byte count rather than a fraction.
          // TODO(cleanup):  This is pretty ugly.  What if exactly 1 byte had been downloaded?
          progress = Math.round(package.progress / 1024) + " KiB";
        } else {
          progress = Math.round(package.progress * 100) + "%";
        }

        return {
          step: package.status,
          progress: progress,
          error: package.status === "failed" ? package.error : null,
          packageId: this.params.packageId
        };
      }

      var result = {
        packageId: this.params.packageId,
        appId: package.appId,
        version: package.manifest.appVersion
      };

      if (UserActions.findOne({ userId: Meteor.userId(), packageId: this.params.packageId })) {
        // This app appears to be installed already.  Check if any grains need updating.

        result.step = "run";

        var existingGrains = Grains.find({ userId: Meteor.userId(), appId: package.appId }).fetch();

        var maxVersion = result.version;

        for (var i in existingGrains) {
          var grain = existingGrains[i];
          if (grain.packageId !== this.params.packageId) {
            // Some other package version.
            if (grain.appVersion <= result.version) {
              result.hasOlderVersion = true;
            } else {
              result.hasNewerVersion = true;
              if (grain.appVersion > maxVersion) {
                maxVersion = grain.appVersion;
                result.newVersionId = grain.packageId;
              }
            }
          }
        }

        return result;
      } else {
        // Check whether some other version is installed and whether it's an older or newer version.
        var oldAction = UserActions.findOne({ userId: Meteor.userId(), appId: package.appId });

        result.step = "confirm";

        if (oldAction) {
          if (oldAction.appVersion <= result.version) {
            result.hasOlderVersion = true;
          } else {
            result.hasNewerVersion = true;
          }
        }

        return result;
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
