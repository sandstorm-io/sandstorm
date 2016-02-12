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

const localizedTextPattern = {
  defaultText: String,
  localizations: Match.Optional([{ locale: String, text: String }]),
};

if (Meteor.isServer) {
  UserActions.allow({
    insert: function (userId, action) {
      // TODO(cleanup): This check keeps breaking. Use a method instead that takes the package
      //   ID as an argument.
      check(action, {
        userId: String,
        packageId: String,
        appId: String,
        appTitle: Match.Optional(localizedTextPattern),
        appMarketingVersion: Match.Optional(Object),
        appVersion: Match.Integer,
        title: localizedTextPattern,
        nounPhrase: Match.Optional(localizedTextPattern),
        command: {
          executablePath: Match.Optional(String),
          deprecatedExecutablePath: Match.Optional(String),
          args: Match.Optional([String]),
          argv: Match.Optional([String]),
          environ: Match.Optional([{ key: String, value: String }]),
        },
      });
      return userId && isSignedUpOrDemo() && action.userId === userId;
    },

    remove: function (userId, action) {
      return userId && action.userId === userId;
    },
  });

  const uploadTokens = {};
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

      const token = Random.id();
      uploadTokens[token] = setTimeout(function () {
        delete uploadTokens[token];
      }, 20 * 60 * 1000);

      return token;
    },

    upgradeGrains: function (appId, version, packageId) {
      this.connection.sandstormDb.upgradeGrains(appId, version, packageId, globalBackend);
    },
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
      } else { // jscs:ignore disallowEmptyBlocks
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
      const pkg = Packages.findOne(packageId);

      if (!pkg || pkg.status !== "ready") {
        if (!this.userId || isDemoUser() || globalDb.isUninvitedFreeUser()) {
          if (!isSafeDemoAppUrl(url)) {
            // TODO(someday): Billing prompt on client side.
            throw new Meteor.Error(403, "Sorry, demo and free users cannot upload custom apps; " +
                "they may only install apps from apps.sandstorm.io.");
          }
        }
      }

      if (!pkg || isRetry) {
        globalDb.startInstall(packageId, url, isRetry);
      }
    }
  },
});

Router.map(function () {
  this.route("install", {
    path: "/install/:packageId",

    waitOn: function () {
      return [
        Meteor.subscribe("packageInfo", this.params.packageId),
        Meteor.subscribe("credentials"),
        // We need UserActions and Grains populated so we can check if we need to upgrade them.
        Meteor.subscribe("grainsMenu"),
      ];
    },

    data: function () {
      if (!this.ready()) return;

      const packageId = this.params.packageId;
      const packageUrl = this.params.query && this.params.query.url;
      const handle = new SandstormAppInstall(packageId, packageUrl, globalDb);

      const pkg = Packages.findOne(packageId);
      if (!Meteor.userId()) {
        if (allowDemo && isSafeDemoAppUrl(packageUrl)) {
          if (pkg && pkg.status === "ready") {
            Router.go("appdemo", { appId: pkg.appId }, { replaceState: true });
            return handle;
          } else {
            // continue on and install...
          } // jscs:ignore disallowEmptyBlocks
        } else {
          handle.setError("You must sign in to install packages.");
          return handle;
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
            window.opener.Router.go("install", { packageId: packageId }, { query: this.params.query });
            window.close();
            return handle;
          }
        } catch (err) {
          // Probably security error because window.opener is in a different domain.
        }

        if (!isSignedUp() && !isDemoUser()) {
          handle.setError("This Sandstorm server requires you to get an invite before installing apps.");
          return handle;
        }
      }

      Meteor.call("ensureInstalled", packageId, packageUrl, false,
            function (err, result) {
              if (err) {
                console.log(err);
                handle.setError(err.message);
              }
            });

      if (pkg === undefined) {
        if (!packageUrl) {
          handle.setError("Unknown package ID: " + packageId +
                   "\nPerhaps it hasn't been uploaded?");
        }

        return handle;
      }

      if (pkg.status !== "ready") {
        if (pkg.status === "failed") {
          handle.setError(pkg.error);
        }

        return handle;
      }

      // From here on, we know the package is installed in the global store, but we
      // might have some per-user things to attend to.
      if (handle.isInstalled()) {
        // The app is installed, so let's send the user to it!  We use `replaceState` so that if
        // the user clicks "back" they don't just get redirected forward again, but end up back
        // at the app list.
        Router.go("appDetails", { appId: handle.appId() }, { replaceState: true });
      }

      return handle;
    },
  });

  this.route("upload", {
    where: "server",
    path: "/upload/:token",

    action: function () {
      if (!this.params.token || !uploadTokens[this.params.token]) {
        this.response.writeHead(403, {
          "Content-Type": "text/plain",
        });
        this.response.write("Invalid upload token.");
        this.response.end();
      } else if (this.request.method === "POST") {
        try {
          const packageId = promiseToFuture(doClientUpload(this.request)).wait();
          this.response.writeHead(200, {
            "Content-Length": packageId.length,
            "Content-Type": "text/plain",
          });
          this.response.write(packageId);
          this.response.end();
          clearTimeout(uploadTokens[this.params.token]);
          delete uploadTokens[this.params.token];
        } catch (error) {
          console.error(error.stack);
          this.response.writeHead(500, {
            "Content-Type": "text/plain",
          });
          this.response.write("Unpacking SPK failed; is it valid?");
          this.response.end();
        };
      } else {
        this.response.writeHead(405, {
          "Content-Type": "text/plain",
        });
        this.response.write("You can only POST here.");
        this.response.end();
      }
    },
  });
});
