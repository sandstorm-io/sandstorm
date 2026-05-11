// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2019 Sandstorm Development Group, Inc. and contributors
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

import { URL } from "url";
import Crypto from "crypto";
import NodeHttp from "http";
import NodeHttps from "https";

import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import { Router } from "meteor/vlasky:galvanized-iron-router";
import { HTTP } from "meteor/http";

import { inMeteor } from "/imports/server/async-helpers";
import { httpCallAsync } from "/imports/http-helpers";
import { globalDb } from "/imports/db-deprecated";
import { createGrainBackup, createBackupToken, restoreGrainBackup, storeGrainBackup }
  from "/imports/server/backup";

function isValidServerUrl(str) {
  let url;
  try {
    url = new URL(str);
  } catch (err) {
    return false;
  }
  if (url.protocol != "http:" && url.protocol != "https:") {
    return false;
  }
  return str == url.protocol + "//" + url.host;
}

Meteor.publish("transfers", function () {
  if (!this.userId) return [];

  return [
    this.connection.sandstormDb.collections.incomingTransfers.find({userId: this.userId},
        {fields: {token: 0, remoteFileToken: 0, localFileToken: 0}}),
    this.connection.sandstormDb.collections.outgoingTransfers.find({userId: this.userId})
  ];
});

Meteor.methods({
  async newTransfer(destination) {
    check(destination, String);
    const account = await Meteor.users.findOneAsync({ _id: this.userId });
    if (!await this.connection.sandstormDb.isAccountSignedUpAsync(account)) {
      throw new Meteor.Error(403, "Must be logged in to start transfers.");
    }

    let db = this.connection.sandstormDb;

    if (await db.collections.incomingTransfers.findOneAsync({ userId: this.userId })) {
      throw new Meteor.Error(403, "Can only authorize one transfer at a time.");
    }
    if (await db.collections.outgoingTransfers.findOneAsync({ userId: this.userId })) {
      throw new Meteor.Error(403, "Can only authorize one transfer at a time.");
    }

    if (!isValidServerUrl(destination)) {
      throw new Meteor.Error(400, "Invalid destination URL.");
    }

    let token = Crypto.randomBytes(32).toString("hex");
    let hash = Crypto.createHash("sha256").update(token).digest("hex");

    await db.collections.outgoingTransfers.insertAsync({
      _id: hash,
      userId: this.userId,
      destination: destination
    });

    return token;
  },

  async cancelTransfers() {
    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to cancel transfers.");
    }

    let db = this.connection.sandstormDb;

    await db.collections.outgoingTransfers.removeAsync({ userId: this.userId });

    await revokeTransferTokens(db, this.userId);
    await db.collections.incomingTransfers.removeAsync({ userId: this.userId });
  },

  async acceptTransfer(source, token) {
    check(source, String);
    check(token, String);
    const account = await Meteor.users.findOneAsync({ _id: this.userId });
    if (!await this.connection.sandstormDb.isAccountSignedUpAsync(account)) {
      throw new Meteor.Error(403, "Must be logged in to start transfers.");
    }
    if (await globalDb.isUserOverQuotaAsync(account)) {
      throw new Meteor.Error(402,
          "You are out of storage space. Please delete some things and try again.");
    }

    if (!isValidServerUrl(source)) {
      throw new Meteor.Error(400, "Invalid source URL: " + source);
    }
    if (!token.match(/^[0-9a-f]{64}$/)) {
      throw new Meteor.Error(400, "Invalid token: " + token);
    }

    let response;
    try {
      response = await httpCallAsync("GET", source + "/transfers/list", {
        headers: {"Authorization": "Bearer " + token}
      });
    } catch (err) {
      throw new Meteor.Error(500, "Couldn't reach source server: " + err.message);
    }
    if (!response.data) {
      throw new Meteor.Error(500, "Source server did not return JSON.");
    }
    if (!response.data.isSansdtormTransferList) {
      throw new Meteor.Error(500, "Source server doesn't look like a Sandstorm server.");
    }
    let grains = response.data.grains;
    check(grains, [Match.ObjectIncluding({
      _id: String,
      appId: String,
      appVersion: Number,
      packageId: String,
      title: String,
      size: Match.Optional(Number),
      lastUsed: Match.Optional(Number)
    })]);

    let db = this.connection.sandstormDb;

    if (await db.collections.incomingTransfers.findOneAsync({ userId: this.userId })) {
      throw new Meteor.Error(403, "Can only authorize one transfer at a time.");
    }
    if (await db.collections.outgoingTransfers.findOneAsync({ userId: this.userId })) {
      throw new Meteor.Error(403, "Can only authorize one transfer at a time.");
    }

    for (const grain of grains) {
      if (!grain._id.match(/^[a-zA-Z0-9]+$/)) {
        throw new Meteor.Error(500, "Bad grain ID from server: " + grain._id);
      }

      await db.collections.incomingTransfers.insertAsync({
        userId: this.userId,
        source,
        token,

        grainId: grain._id,
        appId: grain.appId,
        appVersion: grain.appVersion,
        packageId: grain.packageId,
        title: grain.title,
        size: grain.size,
        lastUsed: grain.lastUsed,

        selected: true,
      });
    }
  },

  async setTransferSelected(transferId, selected) {
    check(transferId, Match.Maybe(String));
    check(selected, Boolean);
    if (!this.userId) return;

    let db = this.connection.sandstormDb;

    if (transferId) {
      await db.collections.incomingTransfers.updateAsync(
          {_id: transferId, userId: this.userId}, {$set: {selected}});
    } else {
      await db.collections.incomingTransfers.updateAsync(
          {userId: this.userId}, {$set: {selected}}, {multi: true});
    }
  },

  async setTransferRunning(running) {
    check(running, Boolean);
    if (!this.userId) return;

    let db = this.connection.sandstormDb;
    if (running) {
      await startOneTransfer(db, this.userId);
    } else {
      await db.collections.incomingTransfers.updateAsync(
          {userId: this.userId, downloading: true}, {$unset: {downloading: 1}}, {multi: true});
    }
  },

  async clearTransferErrors() {
    if (!this.userId) return;

    await globalDb.collections.incomingTransfers.updateAsync(
        {userId: this.userId, error: {$exists: true}},
        {$unset: {error: 1, remoteFileToken: 1, localFileToken: 1}}, {multi: true});
  },
});

function sendError(response, status, message) {
  response.writeHead(status, {
    "Content-Type": "text/plain",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "private",
    "Vary": "Authorization"
  });
  response.write(message);
  response.end();
}

async function checkToken(request, response) {
  let auth = request.headers["authorization"];
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
    return sendError(response, 403, "Missing token.");
  }

  let token = auth.slice("bearer ".length);

  let hash = Crypto.createHash("sha256").update(token).digest("hex");
  let transfer = await globalDb.collections.outgoingTransfers.findOneAsync({ _id: hash });
  if (!transfer) {
    return sendError(response, 403, "Invalid token.");
  }

  return transfer;
}

Router.map(function () {
  this.route("transfersList", {
    where: "server",
    path: "/transfers/list",
    async action() {
      let transfer = await checkToken(this.request, this.response);
      if (!transfer) return;

      let grains = await globalDb.collections.grains.find({userId: transfer.userId},
          {fields: {_id: 1, appId: 1, appVersion: 1, packageId: 1, title: 1, size: 1, lastUsed: 1}})
          .fetchAsync();
      grains.forEach(grain => {
        if (grain.lastUsed) {
          grain.lastUsed = grain.lastUsed.getTime();
        }
      });

      this.response.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "private",
        "Vary": "Authorization"
      });
      this.response.write(JSON.stringify({isSansdtormTransferList: true, grains}));
      this.response.end();
    },
  });

  this.route("transfersCancel", {
    where: "server",
    path: "/transfers/cancel",
    async action() {
      let auth = this.request.headers["authorization"];
      if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
        return sendError(this.response, 403, "Missing token.");
      }

      let token = auth.slice("bearer ".length);

      let hash = Crypto.createHash("sha256").update(token).digest("hex");
      await globalDb.collections.outgoingTransfers.removeAsync({ _id: hash });

      this.response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "private",
        "Vary": "Authorization"
      });
      this.response.end();
    },
  });

  this.route("transfersStart", {
    where: "server",
    path: "/transfers/prepare/:grainId",
    async action() {
      let transfer = await checkToken(this.request, this.response);
      if (!transfer) return;

      let fileToken;
      try {
        fileToken = await createGrainBackup(transfer.userId, this.params.grainId, true);
      } catch (err) {
        let status = (typeof err.error === "number") && err.error >= 400 && err.error < 600
                   ? err.error : 500;
        return sendError(this.response, status, err.reason || "Failed to create backup.");
      }

      this.response.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "private",
        "Vary": "Authorization"
      });
      this.response.end(JSON.stringify({fileToken}));
    },
  });
});

// =======================================================================================

async function startOneTransfer(db, userId) {
  if (await db.collections.incomingTransfers.findOneAsync({ userId, downloading: true })) {
    // Already going.
    return;
  }

  let next = await db.collections.incomingTransfers.findOneAsync({
    userId,
    selected: true,
    downloading: {$exists: false},
    localGrainId: {$exists: false},
    error: {$exists: false}
  }, {sort: {lastUsed: -1}});

  if (next) {
    await db.collections.incomingTransfers.updateAsync({ _id: next._id }, { $set: { downloading: true } });
  } else {
    // If all transfers completed successfully, proactively revoke the token.
    if (!await db.collections.incomingTransfers.findOneAsync({ userId, localGrainId: { $exists: false } })) {
      await revokeTransferTokens(db, userId);
    }
  }
}

async function revokeTransferTokens(db, userId) {
  let revokeMap = {};
  const transfers = await db.collections.incomingTransfers.find({ userId }).fetchAsync();
  transfers.forEach((transfer) => {
    revokeMap[transfer.token] = transfer.source;
  });

  for (let token in revokeMap) {
    HTTP.del(revokeMap[token] + "/transfers/cancel", {
      headers: {"Authorization": "Bearer " + token}
    }, (err, _response) => {
      if (err) {
        // Don't really care...
        console.error("Error revoking transfer token:", err);
      }
    });
  }
}

class Downloader {
  constructor(transfer) {
    Object.assign(this, transfer);
    this.promise = Promise.resolve().then(() => inMeteor(() => this.run()));
    this.canceled = false;
  }

  cancel() {
    this.canceled = true;

    if (this.request) {
      try { this.request.destroy(); } catch (err) {}
      delete this.request;
    }
  }

  async run() {
    try {
      while (!this.canceled) {
        await this.nextStep();
      }
    } catch (err) {
      console.log("error in grain transfer:", err.stack);
      this.error = err.message;
      if (!await globalDb.collections.incomingTransfers.findOneAsync({ _id: this._id, downloading: true })) {
        // Someone unset the "downloading" flag, probably trying to cancel this download, but we
        // didn't notice yet...
        this.canceled = true;
      }
      if (this.canceled) {
        // Error probably caused by cancellation, so don't save the error.
        await globalDb.collections.incomingTransfers.updateAsync(
            { _id: this._id }, { $unset: { downloading: 1 } });
      } else {
        // Not canceled, so the error must be legit. Save it.
        await globalDb.collections.incomingTransfers.updateAsync({_id: this._id},
            {$unset: {downloading: 1}, $set: {error: err.message}});

        // Now start the next transfer.
        await startOneTransfer(globalDb, this.userId);

        this.canceled = true;
      }
    }
  }

  async nextStep() {
    if (!this.remoteFileToken) {
      // Request grain download.
      console.log("mass transfer: packing:", this.grainId);

      let response = await httpCallAsync("POST", this.source + "/transfers/prepare/" + this.grainId,
          { headers: {"Authorization": "Bearer " + this.token} });
      if (!response.data) {
        throw new Meteor.Error(500, "Source server did not return JSON.");
      }
      check(response.data.fileToken, String);
      let remoteFileToken = response.data.fileToken
      this.remoteFileToken = remoteFileToken;

      // Saving localFileToken and remoteFileToken turned out to be a bad idea...
      //globalDb.collections.incomingTransfers.update({_id: this._id}, {$set: {remoteFileToken}});
    }

    if (!this.localFileToken) {
      // Start downloading.
      console.log("mass transfer: downloading:", this.grainId);

      let requestMethod = NodeHttp.request;
      if (this.source.startsWith("https:")) {
        requestMethod = NodeHttps.request;
      }

      this.request = requestMethod(this.source + "/downloadBackup/" + this.remoteFileToken);
      this.request.end();

      const response = await new Promise((resolve, reject) => {
        this.request.on("response", response => {
          resolve(response);
        });
        this.request.on("error", err => {
          reject(err);
        });
      });

      if (this.canceled) return;

      if (response.statusCode != 200) {
        response.destroy();
        if (response.statusCode == 425) {
          // Timed out waiting for file to be ready. Try again.
          return this.nextStep();
        } else if (response.statusCode == 403 || response.statusCode == 404) {
          // Assume token is dead and we need to get a new one.
          await globalDb.collections.incomingTransfers.updateAsync(
              { _id: this._id }, { $unset: { remoteFileToken: 1 } });
          delete this.remoteFileToken;
        }
        throw new Error("Server responded with HTTP error: " + response.statusCode);
      }

      if (this.canceled) return;

      let localFileToken = await createBackupToken();
      await storeGrainBackup(localFileToken, response);

      if (this.canceled) return;

      delete this.request;

      // Saving localFileToken and remoteFileToken turned out to be a bad idea...
      //globalDb.collections.incomingTransfers.update({_id: this._id}, {$set: {localFileToken}});

      this.localFileToken = localFileToken;
    }

    {
      // Finish unpacking.
      console.log("mass transfer: unpacking:", this.grainId);

      const localGrainId = await restoreGrainBackup(this.localFileToken,
          await Meteor.users.findOneAsync({ _id: this.userId }), this);
      if (!await globalDb.collections.incomingTransfers.findOneAsync({ _id: this._id, downloading: true })) {
        // Someone unset the "downloading" flag, probably trying to cancel this download, but we
        // didn't notice yet...
        this.canceled = true;
      }
      let canceled = this.canceled;
      await globalDb.collections.incomingTransfers.updateAsync({_id: this._id}, {
        $set: { localGrainId },
        $unset: { downloading: 1, localFileToken: 1, remoteFileToken: 1 }
      });
      if (!canceled) {
        await startOneTransfer(globalDb, this.userId);
        this.canceled = true;
      }
    }
  }
}

if (!Meteor.settings.replicaNumber) {
  Meteor.startup(() => {
    let downloaders = {};
    globalDb.collections.incomingTransfers.find({downloading: true}).observeAsync({
      added(transfer) {
        if (!downloaders[transfer._id]) {
          downloaders[transfer._id] = new Downloader(transfer);
        }
      },

      removed(transfer) {
        if (downloaders[transfer._id]) {
          downloaders[transfer._id].cancel();
          delete downloaders[transfer._id];
        }
      }
    }).catch((err) => {
      console.error("Failed to observe in-progress incoming transfers:", err);
    });
  });
}
