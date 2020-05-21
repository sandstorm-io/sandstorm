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

import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { _ } from "meteor/underscore";
import { Random } from "meteor/random";
import { Router } from "meteor/iron:router";

import { inMeteor, waitPromise } from "/imports/server/async-helpers.js";

import Capnp from "/imports/server/capnp.js";
import { SandstormDb } from "/imports/sandstorm-db/db.js";
import { globalDb } from "/imports/db-deprecated.js";

const TOKEN_CLEANUP_MINUTES = 120;  // Give enough time for large uploads on slow connections.
const TOKEN_CLEANUP_TIMER = TOKEN_CLEANUP_MINUTES * 60 * 1000;

function cleanupToken(tokenId) {
  check(tokenId, String);
  globalDb.collections.fileTokens.remove({ _id: tokenId });
  waitPromise(globalBackend.cap().deleteBackup(tokenId));
}

Meteor.startup(() => {
  // Cleanup tokens every TOKEN_CLEANUP_MINUTES
  SandstormDb.periodicCleanup(TOKEN_CLEANUP_TIMER, () => {
    const queryDate = new Date(Date.now() - TOKEN_CLEANUP_TIMER);

    globalDb.collections.fileTokens.find({ timestamp: { $lt: queryDate } }).forEach((token) => {
      cleanupToken(token._id);
    });
  });
});

export const createGrainBackup = (userId, grainId, async) => {
  check(grainId, String);
  const grain = globalDb.collections.grains.findOne(grainId);
  if (!grain || !userId || grain.userId !== userId) {
    throw new Meteor.Error(403, "Unauthorized", "User is not the owner of this grain");
  }

  const token = {
    _id: Random.id(),
    timestamp: new Date(),
    name: grain.title,
  };

  // TODO(soon): does the grain need to be offline?

  const grainInfo = _.pick(grain, "appId", "appVersion", "title");
  grainInfo.ownerIdentityId = grain.identityId;
  grainInfo.users = grain.oldUsers || [];

  let users = {};
  globalDb.collections.apiTokens.find({grainId, "owner.user.identityId": {$exists: true}})
      .forEach((token) => {
    let user = token.owner.user;
    users[user.accountId] = user.identityId;
  });

  Meteor.users.find({_id: {$in: [...Object.keys(users)]}}).forEach(account => {
    let credentialIds = _.pluck(account.loginCredentials, "id");

    grainInfo.users.push({
      identityId: users[account._id],
      credentialIds,
      profile: {
        displayName: { defaultText: account.profile.name },
        preferredHandle: account.profile.handle,
        pronouns: account.profile.pronoun,
      }
    });
  });

  if (async) {
    token.async = true;
  }

  globalDb.collections.fileTokens.insert(token);

  let promise = globalBackend.cap().backupGrain(token._id, userId, grainId, grainInfo);

  if (async) {
    promise.then(() => {
      return inMeteor(() => {
        globalDb.collections.fileTokens.update({_id: token._id}, {$unset: {async: 1}});
      });
    }, err => {
      return inMeteor(() => {
        globalDb.collections.fileTokens.update({_id: token._id}, {$unset: {async: 1}, $set: {error: err.message}});
      });
    });
  } else {
    waitPromise(promise);
  }

  return token._id;
};

export const createBackupToken = () => {
  const token = {
    _id: Random.id(),
    timestamp: new Date(),
  };

  globalDb.collections.fileTokens.insert(token);

  return token._id;
};

export const restoreGrainBackup = (tokenId, user, transferInfo) => {
  check(tokenId, String);
  const token = globalDb.collections.fileTokens.findOne(tokenId);
  if (!token) {
    throw new Meteor.Error(403, "Token was not found");
  }

  if (isUserOverQuota(user)) {
    throw new Meteor.Error(402,
        "You are out of storage space. Please delete some things and try again.");
  }

  const grainId = Random.id(22);

  try {
    const grainInfo = waitPromise(globalBackend.cap().restoreGrain(
        tokenId, user._id, grainId).catch((err) => {
          console.error("Unzip failure:", err.message);
          throw new Meteor.Error(500, "Invalid backup file.");
        })).info;
    if (!grainInfo.appId) {
      globalBackend.deleteGrain(grainId, user._id);
      throw new Meteor.Error(500, "Metadata object for uploaded grain has no AppId");
    }

    const action = globalDb.collections.userActions.findOne({ appId: grainInfo.appId, userId: user._id });

    // Create variables we'll use for later Mongo query.
    let packageId;
    let appVersion;

    // DevPackages are system-wide, so we do not check the user ID.
    const devPackage = globalDb.collections.devPackages.findOne({ appId: grainInfo.appId });
    if (devPackage) {
      // If the dev app package exists, it should override the user action.
      packageId = devPackage.packageId;
      appVersion = devPackage.manifest.appVersion;
    } else if (action) {
      // The app is installed, so we can continue restoring this
      // grain.
      packageId = action.packageId;
      appVersion = action.appVersion;
    } else if (transferInfo && transferInfo.appId == grainInfo.appId) {
      packageId = transferInfo.packageId;
      appVersion = transferInfo.appVersion;
    } else {
      // If the package isn't installed at all, bail out.
      globalBackend.deleteGrain(grainId, user._id);
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

    globalDb.collections.grains.insert({
      _id: grainId,
      packageId: packageId,
      appId: grainInfo.appId,
      appVersion: appVersion,
      userId: user._id,
      // For older backups that don't have the owner's identity ID, use the owner's identicon
      // ID which is based on old-style global identity IDs.
      identityId: grainInfo.ownerIdentityId ||
          (user.profile || {}).identicon ||
          SandstormDb.generateIdentityId(),
      title: grainInfo.title,
      private: true,
      size: transferInfo ? transferInfo.size : 0,
      lastUsed: transferInfo ? (transferInfo.lastUsed && new Date(transferInfo.lastUsed)) : new Date(),
      oldUsers: grainInfo.users || [],
    });
  } finally {
    cleanupToken(tokenId);
  }

  return grainId;
};

Meteor.methods({
  backupGrain(grainId) {
    this.unblock();
    return createGrainBackup(this.userId, grainId);
  },

  newRestoreToken() {
    if (!isSignedUpOrDemo()) {
      throw new Meteor.Error(403, "Unauthorized", "Only invited users can restore backups.");
    }

    if (isUserOverQuota(Meteor.user())) {
      throw new Meteor.Error(402,
          "You are out of storage space. Please delete some things and try again.");
    }

    return createBackupToken();
  },

  restoreGrain(tokenId, obsolete) {
    if (!isSignedUpOrDemo()) {
      throw new Meteor.Error(403, "User cannot create grains");
    }
    this.unblock();
    return restoreGrainBackup(tokenId, Meteor.user());
  },
});

downloadGrainBackup = (tokenId, response, retryCount = 0) => {
  const token = globalDb.collections.fileTokens.findOne(tokenId);
  if (!token) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    return response.end("File does not exist");
  }

  if (token.error) {
    response.writeHead(500, { "Content-Type": "text/plain", "Cache-Control": "private" });
    return response.end(token.error);
  }

  if (token.async) {
    if (retryCount == 10) {
      response.writeHead(425, { "Content-Type": "text/plain", "Cache-Control": "private" });
      return response.end("Try again.");
    }
    waitPromise(new Promise(resolve => setTimeout(resolve, 1000)));
    return downloadGrainBackup(tokenId, response, retryCount + 1);
  }

  let started = false;
  const encodedFilename = encodeURIComponent(token.name || "backup") + ".zip";
  let sawEnd = false;

  const stream = {
    expectSize(size) {
      if (!started) {
        started = true;
        response.writeHead(200, {
          "Content-Length": size,
          "Content-Type": "application/zip",
          "Cache-Control": "private",
          "Content-Disposition": "attachment;filename*=utf-8''" + encodedFilename,
        });
      }
    },

    write(data) {
      if (!started) {
        started = true;
        response.writeHead(200, {
          "Content-Type": "application/zip",
          "Cache-Control": "private",
          "Content-Disposition": "attachment;filename*=utf-8''" + encodedFilename,
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
          "Cache-Control": "private",
          "Content-Disposition": "attachment;filename*=utf-8''" + encodedFilename,
        });
      }

      sawEnd = true;
      response.end();
    },
  };

  waitPromise(globalBackend.cap().downloadBackup(tokenId, stream));

  if (!sawEnd) {
    console.error("backend failed to call done() when downloading backup");
    if (!started) {
      throw new Meteor.Error(500, "backend failed to produce data");
    }

    response.end();
  }

  cleanupToken(tokenId);
}

export const storeGrainBackup = (tokenId, inputStream) => {
  const stream = globalBackend.cap().uploadBackup(tokenId).stream;

  waitPromise(new Promise((resolve, reject) => {
    inputStream.on("data", (data) => {
      stream.write(data);
    });
    inputStream.on("end", () => {
      resolve(stream.done());
    });
    inputStream.on("error", (err) => {
      stream.close();
    });
  }));
}

Router.map(function () {
  this.route("downloadBackup", {
    where: "server",
    path: "/downloadBackup/:tokenId",
    action() {
      downloadGrainBackup(this.params.tokenId, this.response);
    },
  });

  this.route("uploadBackup", {
    where: "server",
    path: "/uploadBackup/:token",
    action() {
      if (this.request.method === "POST") {
        const token = globalDb.collections.fileTokens.findOne(this.params.token);
        if (!this.params.token || !token) {
          this.response.writeHead(403, {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*",
          });
          this.response.write("Invalid upload token.");
          this.response.end();
          return;
        }

        try {
          storeGrainBackup(this.params.token, this.request);

          this.response.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
          });
          this.response.end();
        } catch (error) {
          console.error(error.stack);
          this.response.writeHead(500, {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*",
          });
          this.response.write(error.stack);
          this.response.end();
        }
      } else if (this.request.method == "OPTIONS") {
        // Allow cross-origin posts to uploadBackup so that uploads can occur on the DDP host
        // rather than the main host. In theory we could have Access-Control-Allow-Origin specify
        // the main host rather than "*", but an uploadBackup request already requires a valid
        // upload token, which is plenty of access control in itself.
        const requestedHeaders = this.request.headers["access-control-request-headers"];
        if (requestedHeaders) {
          this.response.setHeader("Access-Control-Allow-Headers", requestedHeaders);
        }

        this.response.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Max-Age": "3600",
        });
        this.response.end();
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
