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

var ChildProcess = Npm.require("child_process");
var Future = Npm.require("fibers/future");
var Promise = Npm.require("es6-promise").Promise;
var Capnp = Npm.require("capnp");

var GrainInfo = Capnp.importSystem("sandstorm/grain.capnp").GrainInfo;

var TOKEN_CLEANUP_MINUTES = 15;
var TOKEN_CLEANUP_TIMER = TOKEN_CLEANUP_MINUTES * 60 * 1000;

function cleanupToken(tokenId) {
  check(tokenId, String);
  waitPromise(sandstormBackend.deleteBackup(tokenId));
  FileTokens.remove({_id: tokenId});
}

Meteor.startup(function () {
  // Cleanup tokens every TOKEN_CLEANUP_MINUTES
  Meteor.setInterval(function () {
    var queryDate = new Date(Date.now() - TOKEN_CLEANUP_TIMER);

    FileTokens.find({timestamp: {$lt: queryDate}}).forEach(function (token) {
      cleanupToken(token._id);
    });
  }, TOKEN_CLEANUP_TIMER);
});

Meteor.methods({
  backupGrain: function (grainId) {
    check(grainId, String);
    var grain = Grains.findOne(grainId);
    if (!grain || !this.userId || grain.userId !== this.userId) {
      throw new Meteor.Error(403, "Unauthorized", "User is not the owner of this grain");
    }

    this.unblock();

    var token = {
      _id: Random.id(),
      timestamp: new Date(),
      name: grain.title
    };

    // TODO(soon): does the grain need to be offline?

    var grainInfo = _.pick(grain, "appId", "appVersion", "title");

    FileTokens.insert(token);
    waitPromise(sandstormBackend.backupGrain(token._id, this.userId, grainId, grainInfo));

    return token._id;
  },

  restoreGrain: function (tokenId) {
    check(tokenId, String);
    var token = FileTokens.findOne(tokenId);
    if (!token || !isSignedUpOrDemo()) {
      throw new Meteor.Error(403, "Unauthorized",
          "Token was not found, or user cannot create grains");
    }
    if (isUserOverQuota(Meteor.user())) {
      throw new Meteor.Error(402,
          "You are out of storage space. Please delete some things and try again.");
    }

    this.unblock();

    var grainId = Random.id(22);

    try {
      var grainInfo = waitPromise(sandstormBackend.restoreGrain(
          tokenId, this.userId, grainId).catch(function (err) {
            console.error("Unzip failure:", err.message);
            throw new Meteor.Error(500, "Invalid backup file.");
          })).info;
      if (!grainInfo.appId) {
        deleteGrain(grainId, this.userId);
        throw new Meteor.Error(500, "Metadata object for uploaded grain has no AppId");
      }

      var action = UserActions.findOne({appId: grainInfo.appId, userId: this.userId});
      // Create variables we'll use for later Mongo query.
      var packageId;
      var appVersion;
      // DevApps are system-wide, so we do not check the user ID.
      var devApp = DevApps.findOne({_id: grainInfo.appId});

      if (action) {
        // The app is installed, so we can continue restoring this
        // grain.
        packageId = action.packageId;
        appVersion = action.appVersion;
      } else if (devApp) {
        // If the dev app exists, permit this.
        packageId = devApp.packageId;
        appVersion = devApp.manifest.appVersion;
      } else {
        // If the package isn't installed at all, bail out.
        deleteGrain(grainId, this.userId);
        throw new Meteor.Error(500,
                               "App id for uploaded grain not installed",
                               "App Id: " + grainInfo.appId);
      }

      if (appVersion < grainInfo.appVersion) {
        deleteGrain(grainId, this.userId);
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
        title: grainInfo.title,
        private: true
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
    action: function () {
      var token = FileTokens.findOne(this.params.tokenId);
      var response = this.response;
      if (!token) {
        response.writeHead(404, {"Content-Type": "text/plain"});
        return response.end("File does not exist");
      }

      var started = false;
      var filename = (token.name.replace(/["\n]/g, "") || "backup") + ".zip";
      var sawEnd = false;

      var stream = {
        expectSize: function (size) {
          if (!started) {
            started = true;
            response.writeHead(200, {
              "Content-Length": size,
              "Content-Type": "application/zip",
              "Content-Disposition": "attachment;filename=\"" + filename + "\""
            });
          }
        },
        write: function (data) {
          if (!started) {
            started = true;
            response.writeHead(200, {
              "Content-Type": "application/zip",
              "Content-Disposition": "attachment;filename=\"" + filename + "\""
            });
          }
          response.write(data);
        },
        done: function (data) {
          if (!started) {
            started = true;
            response.writeHead(200, {
              "Content-Length": 0,
              "Content-Type": "application/zip",
              "Content-Disposition": "attachment;filename=\"" + filename + "\""
            });
          }
          sawEnd = true;
          response.end();
        }
      };

      waitPromise(sandstormBackend.downloadBackup(this.params.tokenId, stream));

      if (!sawEnd) {
        console.error("backend failed to call done() when downloading backup");
        if (!started) {
          throw new Meteor.Error(500, "backend failed to produce data");
        }
        response.end();
      }

      cleanupToken(this.params.tokenId);
    }
  });

  this.route("uploadBackup", {
    where: "server",
    path: "/uploadBackup",
    action: function () {
      if (this.request.method === "POST") {
        var request = this.request;
        try {
          var token = {
            _id: Random.id(),
            timestamp: new Date()
          };
          var stream = sandstormBackend.uploadBackup(token._id).stream;

          FileTokens.insert(token);

          waitPromise(new Promise(function (resolve, reject) {
            request.on("data", function (data) {
              stream.write(data);
            });
            request.on("end", function () {
              resolve(stream.done());
            });
            request.on("error", function (err) {
              stream.close();
            });
          }));

          this.response.writeHead(200, {
            "Content-Length": token._id.length,
            "Content-Type": "text/plain"
          });
          this.response.write(token._id);
          this.response.end();
        } catch(error) {
          console.error(error.stack);
          this.response.writeHead(500, {
            "Content-Type": "text/plain"
          });
          this.response.write(error.stack);
          this.response.end();
        }
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
