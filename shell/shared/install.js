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

// This file covers /install and /upload.

if (Meteor.isServer) {
  UserActions.allow({
    insert: function (userId, action) {
      // TODO(cleanup): This check keeps breaking. Use a method instead that takes the package
      //   ID as an argument.
      check(action, {
        userId: String,
        packageId: String,
        appId: String,
        appTitle: Match.Optional(String),
        appMarketingVersion: Match.Optional(Object),
        appVersion: Match.Integer,
        title: String,
        nounPhrase: Match.Optional(String),
        command: {
          executablePath: Match.Optional(String),
          deprecatedExecutablePath: Match.Optional(String),
          args: Match.Optional([String]),
          argv: Match.Optional([String]),
          environ: Match.Optional([{key: String, value: String}])
        }
      });
      return userId && isSignedUpOrDemo() && action.userId === userId;
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

  var uploadTokens = {};
  // Not all users are allowed to upload apps. We need to manually implement authorization
  // because Meteor.userId() is not available in server-side routes.

  Meteor.methods({
    cancelDownload: function (packageId) {
      check(packageId, String);

      // TODO(security):  Only let user cancel download if they initiated it.
      cancelDownload(packageId);
    },

    newUploadToken: function () {
      if (!isSignedUp()) {
        throw new Meteor.Error(403, "Unauthorized", "Only invited users can upload apps.");
      }
      if (globalDb.isUninvitedFreeUser()) {
        throw new Meteor.Error(403, "Unauthorized", "Only paid users can upload apps.");
      }
      var token = Random.id();
      uploadTokens[token] = setTimeout(function () {
        delete uploadTokens[token];
      }, 20 * 60 * 1000);
      return token;
    }
  });
}

function isSafeDemoAppUrl(url) {
  // For demo accounts, we allow using a bare hash with no URL (which will never upload a new app)
  // and we allow specifying a sandstorm.io URL.
  return !url ||
      url.lastIndexOf("http://sandstorm.io/", 0) === 0 ||
      url.lastIndexOf("https://sandstorm.io/", 0) === 0 ||
      url.lastIndexOf("https://alpha-j7uny7u376jnimcsx34c.sandstorm.io/", 0) === 0 ||
      url.lastIndexOf("https://app-index.sandstorm.io/", 0) === 0;
}

Meteor.methods({
  ensureInstalled: function (packageId, url, isRetry) {
    check(packageId, String);
    check(url, Match.OneOf(String, undefined, null));
    check(isRetry, Boolean);

    if (!packageId.match(/^[a-zA-Z0-9]*$/)) {
      throw new Meteor.Error(400, "The package ID contains illegal characters.");
    }

    if (!this.userId) {
      if (allowDemo && isSafeDemoAppUrl(url)) {
        // continue on
      } else {
        throw new Meteor.Error(403, "You must be logged in to install packages.");
      }
    } else if (!isSignedUp() && !isDemoUser()) {
      throw new Meteor.Error(403,
          "This Sandstorm server requires you to get an invite before installing apps.");
    } else if (isUserOverQuota(Meteor.user())) {
      throw new Meteor.Error(402,
          "You are out of storage space. Please delete some things and try again.");
    }

    if (!this.isSimulation) {
      var pkg = Packages.findOne(packageId);

      if (!pkg || pkg.status !== "ready") {
        if (!this.userId || isDemoUser() || globalDb.isUninvitedFreeUser()) {
          if (!isSafeDemoAppUrl(url)) {
            // TODO(someday): Billing prompt on client side.
            throw new Meteor.Error(403, "Sorry, demo and free users cannot upload custom apps; " +
                "they may only install apps from apps.sandstorm.io.");
          }
        }
      }

      if (pkg) {
        if (isRetry) {
          if (pkg.status !== "failed") {
            throw new Meteor.Error(403, "Unauthorized",
                                   "Can't retry an install that hasn't failed.");
          }
          startInstall(packageId, url, true, pkg.appId)
        } else if (pkg.status === "failed" || pkg.status === "ready") {
          return;
        } else {
          if (pkg.status === "delete") {
            // Either someone is currently deleting the package, or
            // the server previously crashed mid-delete. In either
            // case, we try to resume the deletion before continuing.
            deletePackage(packageId);
          }
          startInstall(packageId, url, false, pkg.appId);
        }
      } else {
        startInstall(packageId, url, true);
      }
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
        shutdownGrain(grain._id, grain.userId);
      });
    }

    Grains.update(selector, { $set: { appVersion: version, packageId: packageId }}, {multi: true});
  },
});

if (Meteor.isClient) {
  addUserActions = function(packageId) {
    var package = Packages.findOne(packageId);
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
          var userAction = {
            userId: Meteor.userId(),
            packageId: package._id,
            appId: package.appId,
            appTitle: package.manifest.appTitle && package.manifest.appTitle.defaultText,
            appMarketingVersion: package.manifest.appMarketingVersion,
            appVersion: package.manifest.appVersion,
            title: action.title.defaultText,  // TODO(someday): `.defaultText` here is wrong.
            command: action.command
          };
          if (action.nounPhrase) {
            // TODO(someday): `.defaultText` here is wrong.
            userAction.nounPhrase = action.nounPhrase.defaultText;
          }
          UserActions.insert(userAction);
        } else {
          // TODO(someday):  Implement actions with capability inputs.
        }
      }

      Meteor.call("deleteUnusedPackages", package.appId);
    }
  }

  Template.install.events({
    "click #retry": function (event) {
      Meteor.call("ensureInstalled", this.packageId, this.packageUrl, true);
    },

    "click #cancelDownload": function (event) {
      Meteor.call("cancelDownload", this.packageId);
    },

    "click #confirmInstall": function (event) {
      addUserActions(this.packageId);
    },

    "click #upgradeGrains": function (event) {
      Meteor.call("upgradeGrains", this.appId, this.version, this.packageId);
    }
  });
}

function referredFromSandstorm() {
  return document.referrer.lastIndexOf("https://sandstorm.io/apps/", 0) === 0 ||
         document.referrer.lastIndexOf("https://apps.sandstorm.io/", 0) === 0;
}

Router.map(function () {
  this.route("install", {
    path: "/install/:packageId",

    waitOn: function () {
      return [
        Meteor.subscribe("packageInfo", this.params.packageId),
        Meteor.subscribe("credentials"),
        // We need UserActions and Grains populated so we can check if we need to upgrade them.
        Meteor.subscribe("grainsMenu")
      ];
    },

    data: function () {
      if (!this.ready()) return;

      var packageId = this.params.packageId;
      var package = Packages.findOne(packageId);
      var userId = Meteor.userId();
      var packageUrl = this.params.query && this.params.query.url;

      if (!userId) {
        if (allowDemo && isSafeDemoAppUrl(packageUrl)) {
          if (package && package.status === "ready") {
            Router.go("appdemo", {appId: package.appId}, {replaceState: true});
            return;
          } else {
            // continue on and install...
          }
        } else {
          return { error: "You must sign in to install packages.", packageId: packageId };
        }
      } else {
        try {
          // When the user clicks to install an app, the app store is opened in a new tab. When they
          // choose an app in the app store, they are redirected back to Sandstorm. But we'd really
          // like to bring them back to the tab where they clicked "install apps". It turns out we
          // can exploit a terrible feature of the web platform to do this: window.opener is a
          // pointer to the tab which opened this tab, and we can actually reach right into it and
          // call functions in it. So, we redirect the original tab to install the app, then close
          // this one.
          if (globalGrains.get().length === 0 &&
              window.opener.location.hostname === window.location.hostname &&
              window.opener.Router) {
            if (referredFromSandstorm()) {
              // Hack: Communicate to parent that we were referred from Sandstorm.
              window.opener.referredFromSandstorm = packageId;
            }
            window.opener.Router.go("install", {packageId: packageId}, {query: this.params.query});
            window.close();
            return;
          }
        } catch (err) {
          // Probably security error because window.opener is in a different domain.
        }

        if (!isSignedUp() && !isDemoUser()) {
          return { error:
              "This Sandstorm server requires you to get an invite before installing apps.",
              packageId: packageId };
        }
      }

      // If ensureInstalled throws an exception without even starting installation, we'll treat
      // it as a permanent error.
      var previousError = Session.get("install-error-" + packageId);
      if (previousError) {
        return { error: previousError, packageId: packageId };
      }

      Meteor.call("ensureInstalled", packageId, packageUrl, false,
            function (err, result) {
         if (err) {
           Session.set("install-error-" + packageId, err.message);
         }
      });

      if (package === undefined) {
        if (!packageUrl) {
          return { error: "Unknown package ID: " + packageId +
                   "\nPerhaps it hasn't been uploaded?",
                   packageId: packageId, packageUrl: packageUrl };
        } else {
          return { step: "wait" };
        }
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
          packageId: packageId,
          packageUrl: packageUrl
        };
      }

      var result = {
        packageId: packageId,
        packageUrl: packageUrl,
        appId: package.appId,
        version: package.manifest.appVersion
      };

      if (UserActions.findOne({ userId: Meteor.userId(), packageId: packageId })) {
        // This app appears to be installed already.  Check if any grains need updating.

        result.step = "run";

        var existingGrains = Grains.find({ userId: Meteor.userId(), appId: package.appId }).fetch();

        var maxVersion = result.version;

        for (var i in existingGrains) {
          var grain = existingGrains[i];
          if (grain.packageId !== packageId) {
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

        if (!result.hasOlderVersion && !result.hasNewerVersion) {
          // OK, the app is installed and everything and there's no warnings to print, so let's
          // just go to it! We use `replaceState` so that if the user clicks "back" they don't just
          // get redirected forward again, but end up back at the app list.
          Router.go("newGrain", {}, {replaceState: true, query: {highlight: package.appId }});
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

        if (!result.hasOlderVersion && !result.hasNewerVersion &&
            (window.referredFromSandstorm === packageId || referredFromSandstorm())) {
          // Skip confirmation because we assume the Sandstorm app list is not evil.
          // TODO(security): This is not excellent. Think harder.
          delete window.referredFromSandstorm;
          addUserActions(result.packageId);
          Router.go("newGrain", {}, {replaceState: true});
        }

        return result;
      }
    }
  });

  this.route("upload", {
    where: "server",
    path: "/upload/:token",

    action: function () {
      if (!this.params.token || !uploadTokens[this.params.token]) {
        this.response.writeHead(403, {
          "Content-Type": "text/plain"
        });
        this.response.write("Invalid upload token.");
        this.response.end();
      } else if (this.request.method === "POST") {
        try {
          var self = this;
          var packageId = promiseToFuture(doClientUpload(this.request)).wait();
          self.response.writeHead(200, {
            "Content-Length": packageId.length,
            "Content-Type": "text/plain"
          });
          self.response.write(packageId);
          self.response.end();
          clearTimeout(uploadTokens[this.params.token]);
          delete uploadTokens[this.params.token];
        } catch(error) {
          console.error(error.stack);
          self.response.writeHead(500, {
            "Content-Type": "text/plain"
          });
          self.response.write("Unpacking SPK failed; is it valid?");
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
