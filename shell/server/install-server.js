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

import { allowDemo } from "/imports/demo.js";
import { promiseToFuture } from "/imports/server/async-helpers.js";

const localizedTextPattern = {
  defaultText: String,
  localizations: Match.Optional([{ locale: String, text: String }]),
};

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

    const token = Random.id(22);
    uploadTokens[token] = setTimeout(function () {
      delete uploadTokens[token];
    }, 20 * 60 * 1000);

    return token;
  },

  upgradeGrains: function (appId, version, packageId) {
    this.connection.sandstormDb.upgradeGrains(appId, version, packageId, globalBackend);
  },

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
  },
});

Meteor.publish("packageInfo", function (packageId) {
  check(packageId, String);
  const db = this.connection.sandstormDb;
  const pkgCursor = db.collections.packages.find(packageId);
  const pkg = pkgCursor.fetch()[0];
  if (pkg && this.userId) {
    return [
      pkgCursor,
      db.collections.userActions.find({ userId: this.userId, appId: pkg.appId }),
      db.collections.grains.find({ userId: this.userId, appId: pkg.appId }),
    ];
  } else {
    return pkgCursor;
  }
});

Router.map(function () {
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
