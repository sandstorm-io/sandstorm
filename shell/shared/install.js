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

// This file covers /install and /upload.

if (Meteor.isServer) {
  UserActions.allow({
    insert: function (userId, action) {
      check(action, {
        _id: String,
        userId: String,
        packageId: String,
        appId: String,
        appVersion: Match.Integer,
        title: String,
        command: {
          executablePath: String,
          args: Match.Optional([String]),
          environ: Match.Optional([{key: String, value: String}])
        }
      });
      return userId && isSignedUp() && action.userId === userId;
    },
    remove: function (userId, action) {
      return userId && action.userId === userId;
    }
  });

  Meteor.publish("packageInfo", function (packageId) {
    check(packageId, String);

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

  Meteor.methods({
    cancelDownload: function (packageId) {
      check(packageId, String);

      // TODO(security):  Only let user cancel download if they initiated it.
      cancelDownload(packageId);
    }
  });
}

Meteor.methods({
  ensureInstalled: function (packageId, url) {
    check(packageId, String);
    check(url, Match.OneOf(String, undefined, null));

    if (!packageId.match(/^[a-zA-Z0-9]*$/)) {
      throw new Meteor.Error(400, "Bad package name", "The package name contains illegal characters.");
    }

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

  retryInstall: function (packageId, url) {
    check(packageId, String);
    check(url, Match.OneOf(String, undefined, null));

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
    check(appId, String);
    check(version, Match.Integer);
    check(packageId, String);

    var selector = {
      userId: this.userId,
      appId: appId,
      appVersion: { $lte: version },
      packageId: { $ne: packageId }
    };

    if (!this.isSimulation) {
      Grains.find(selector).forEach(function (grain) {
        shutdownGrain(grain._id);
      });
    }

    Grains.update(selector, { $set: { appVersion: version, packageId: packageId }}, {multi: true});
  },
});

if (Meteor.isClient) {
  Template.install.events({
    "click #retry": function (event) {
      Meteor.call("retryInstall", this.packageId, this.packageUrl);
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

  Template.uploadForm.events({
    "click #uploadButton": function (event) {
      Session.set("uploadError", undefined);

      var file = document.getElementById("uploadFile").files[0];
      if (!file) {
        alert("Please select a file.");
        return;
      }

      var xhr = new XMLHttpRequest();

      xhr.onreadystatechange = function () {
        if (xhr.readyState == 4) {
          Session.set("uploadProgress", undefined);
          if (xhr.status == 200) {
            Router.go("install", {packageId: xhr.responseText});
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
              Math.round(progressEvent.loaded / progressEvent.total * 100));
        });
      }

      xhr.open("POST", "/upload", true);
      xhr.send(file);
    }
  });
}

Router.map(function () {
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

      Meteor.call("ensureInstalled", this.params.packageId, this.params.url);

      var package = Packages.findOne(this.params.packageId);
      if (package === undefined) {
        // Apparently, this app is not installed nor installing, which implies that no URL was
        // provided, which means we cannot install it.
        // TODO(soon):  Display upload page?
        return { error: "Unknown package ID: " + this.params.packageId +
                        "\nPerhaps it hasn't been uploaded?",
                 packageId: this.params.packageId, packageUrl: this.params.url };
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
          packageId: this.params.packageId,
          packageUrl: this.params.url
        };
      }

      var result = {
        packageId: this.params.packageId,
        packageUrl: this.params.url,
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

  this.route("uploadForm", {
    path: "/install",

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

  this.route("upload", {
    where: "server",
    path: "/upload",

    action: function () {
      if (this.request.method === "POST") {
        try {
          var self = this;
          var packageId = promiseToFuture(doClientUpload(this.request)).wait();
          self.response.writeHead(200, {
            "Content-Length": packageId.length,
            "Content-Type": "text/plain"
          });
          self.response.write(packageId);
          self.response.end();
        } catch(error) {
          console.error(error.stack);
          self.response.writeHead(500, {
            "Content-Type": "text/plain"
          });
          self.response.write(error.stack);
          self.response.end();
        };
      } else {
        this.response.writeHead(405, {
          "Content-Type": "text/plain"
        });
        this.response.write("You can only POST here.");
        this.response.end();
      }
    }
  });
});
