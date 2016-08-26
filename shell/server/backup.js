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

import { waitPromise } from "/imports/server/async-helpers.js";

const ChildProcess = Npm.require("child_process");
const Future = Npm.require("fibers/future");
const Capnp = Npm.require("capnp");

const GrainInfo = Capnp.importSystem("sandstorm/grain.capnp").GrainInfo;

const TOKEN_CLEANUP_MINUTES = 15;
const TOKEN_CLEANUP_TIMER = TOKEN_CLEANUP_MINUTES * 60 * 1000;

function cleanupToken(tokenId) {
  check(tokenId, String);
  FileTokens.remove({ _id: tokenId });
  waitPromise(globalBackend.cap().deleteBackup(tokenId));
}

Meteor.startup(() => {
  // Cleanup tokens every TOKEN_CLEANUP_MINUTES
  SandstormDb.periodicCleanup(TOKEN_CLEANUP_TIMER, () => {
    const queryDate = new Date(Date.now() - TOKEN_CLEANUP_TIMER);

    FileTokens.find({ timestamp: { $lt: queryDate } }).forEach((token) => {
      cleanupToken(token._id);
    });
  });
});

Meteor.methods({
  backupGrain(grainId) {
    check(grainId, String);
    const grain = Grains.findOne(grainId);
    if (!grain || !this.userId || grain.userId !== this.userId) {
      throw new Meteor.Error(403, "Unauthorized", "User is not the owner of this grain");
    }

    this.unblock();

    const token = {
      _id: Random.id(),
      timestamp: new Date(),
      name: grain.title,
    };

    // TODO(soon): does the grain need to be offline?

    const grainInfo = _.pick(grain, "appId", "appVersion", "title");

    FileTokens.insert(token);
    waitPromise(globalBackend.cap().backupGrain(token._id, this.userId, grainId, grainInfo));

    return token._id;
  },

  newRestoreToken() {
    if (!isSignedUpOrDemo()) {
      throw new Meteor.Error(403, "Unauthorized", "Only invited users can restore backups.");
    }

    if (isUserOverQuota(Meteor.user())) {
      throw new Meteor.Error(402,
          "You are out of storage space. Please delete some things and try again.");
    }

    const token = {
      _id: Random.id(),
      timestamp: new Date(),
    };

    FileTokens.insert(token);

    return token._id;
  },

  restoreGrain(tokenId, identityId) {
    check(tokenId, String);
    check(identityId, String);
    const token = FileTokens.findOne(tokenId);
    if (!token || !isSignedUpOrDemo()) {
      throw new Meteor.Error(403, "Unauthorized",
          "Token was not found, or user cannot create grains");
    }

    if (isUserOverQuota(Meteor.user())) {
      throw new Meteor.Error(402,
          "You are out of storage space. Please delete some things and try again.");
    }

    this.unblock();

    const grainId = Random.id(22);

    try {
      const grainInfo = waitPromise(globalBackend.cap().restoreGrain(
          tokenId, this.userId, grainId).catch((err) => {
            console.error("Unzip failure:", err.message);
            throw new Meteor.Error(500, "Invalid backup file.");
          })).info;
      if (!grainInfo.appId) {
        globalBackend.deleteGrain(grainId, this.userId);
        throw new Meteor.Error(500, "Metadata object for uploaded grain has no AppId");
      }

      const action = UserActions.findOne({ appId: grainInfo.appId, userId: this.userId });

      // Create variables we'll use for later Mongo query.
      let packageId;
      let appVersion;

      // DevPackages are system-wide, so we do not check the user ID.
      const devPackage = DevPackages.findOne({ appId: grainInfo.appId });
      if (devPackage) {
        // If the dev app package exists, it should override the user action.
        packageId = devPackage.packageId;
        appVersion = devPackage.manifest.appVersion;
      } else if (action) {
        // The app is installed, so we can continue restoring this
        // grain.
        packageId = action.packageId;
        appVersion = action.appVersion;
      } else {
        // If the package isn't installed at all, bail out.
        globalBackend.deleteGrain(grainId, this.userId);
        throw new Meteor.Error(500,
                               "App id for uploaded grain not installed",
                               "App Id: " + grainInfo.appId);
      }

      if (appVersion < grainInfo.appVersion) {
        globalBackend.deleteGrain(grainId, this.userId);
        throw new Meteor.Error(500,
                               "App version for uploaded grain is newer than any " +
                               "installed version. You need to upgrade your app first",
                               "New version: " + grainInfo.appVersion +
                               ", Old version: " + appVersion);
      }

      Grains.insert({
        _id: grainId,
        packageId: packageId,
        appId: grainInfo.appId,
        appVersion: appVersion,
        userId: this.userId,
        identityId: identityId,
        title: grainInfo.title,
        private: true,
        size: 0,
      });
    } finally {
      cleanupToken(tokenId);
    }

    return grainId;
  },
});

Router.map(function () {
  this.route("downloadBackup", {
    where: "server",
    path: "/downloadBackup/:tokenId",
    action() {
      const token = FileTokens.findOne(this.params.tokenId);
      const response = this.response;
      if (!token) {
        response.writeHead(404, { "Content-Type": "text/plain" });
        return response.end("File does not exist");
      }

      let started = false;
      const filename = (token.name.replace(/["\n]/g, "") || "backup") + ".zip";
      let sawEnd = false;

      const stream = {
        expectSize(size) {
          if (!started) {
            started = true;
            response.writeHead(200, {
              "Content-Length": size,
              "Content-Type": "application/zip",
              "Content-Disposition": 'attachment;filename=\"' + filename + '\"',
            });
          }
        },

        write(data) {
          if (!started) {
            started = true;
            response.writeHead(200, {
              "Content-Type": "application/zip",
              "Content-Disposition": 'attachment;filename=\"' + filename + '\"',
            });
          }

          response.write(data);
        },

        done(data) {
          if (!started) {
            started = true;
            response.writeHead(200, {
              "Content-Length": 0,
              "Content-Type": "application/zip",
              "Content-Disposition": 'attachment;filename=\"' + filename + '\"',
            });
          }

          sawEnd = true;
          response.end();
        },
      };

      waitPromise(globalBackend.cap().downloadBackup(this.params.tokenId, stream));

      if (!sawEnd) {
        console.error("backend failed to call done() when downloading backup");
        if (!started) {
          throw new Meteor.Error(500, "backend failed to produce data");
        }

        response.end();
      }

      cleanupToken(this.params.tokenId);
    },
  });

  this.route("uploadBackup", {
    where: "server",
    path: "/uploadBackup/:token",
    action() {
      if (this.request.method === "POST") {
        const token = FileTokens.findOne(this.params.token);
        if (!this.params.token || !token) {
          this.response.writeHead(403, {
            "Content-Type": "text/plain",
          });
          this.response.write("Invalid upload token.");
          this.response.end();
          return;
        }

        const request = this.request;
        try {
          const stream = globalBackend.cap().uploadBackup(this.params.token).stream;

          waitPromise(new Promise((resolve, reject) => {
            request.on("data", (data) => {
              stream.write(data);
            });
            request.on("end", () => {
              resolve(stream.done());
            });
            request.on("error", (err) => {
              stream.close();
            });
          }));

          this.response.writeHead(204);
          this.response.end();
        } catch (error) {
          console.error(error.stack);
          this.response.writeHead(500, {
            "Content-Type": "text/plain",
          });
          this.response.write(error.stack);
          this.response.end();
        }
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
