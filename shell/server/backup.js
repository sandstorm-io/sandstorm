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
var Fs = Npm.require("fs");
var Future = Npm.require("fibers/future");
var Path = Npm.require("path");

var GrainInfo = Capnp.importSystem("sandstorm/grain.capnp").GrainInfo;

var TMPDIR = "/tmp";
var TOKEN_CLEANUP_MINUTES = 15;
var TOKEN_CLEANUP_TIMER = TOKEN_CLEANUP_MINUTES * 60 * 1000;

var mkdir = Meteor._wrapAsync(Fs.mkdir),
    readFile = Meteor._wrapAsync(Fs.readFile),
    writeFile = Meteor._wrapAsync(Fs.writeFile);

function recursiveRmdirIfExists(dir) {
  if (Fs.existsSync(dir)) {
    if (Fs.lstatSync(dir).isDirectory()) {
      recursiveRmdir(dir);
    } else {
      Fs.unlinkSync(dir);
    }
  }
}

Meteor.startup(function () {
  // Cleanup tokens every TOKEN_CLEANUP_MINUTES
  Meteor.setInterval(function () {
    var queryDate = new Date(Date.now() - TOKEN_CLEANUP_TIMER);

    FileTokens.find({timestamp: {$lt: queryDate}}).forEach(function (token) {
      Meteor.call("cleanupToken", token._id);
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

    var fut = new Future();

    var id = Random.id();
    var token = {
      _id: id,
      filePath: Path.join(TMPDIR, "/", id),
      timestamp: new Date(),
      name: grain.title
    };

    mkdir(token.filePath);

    // TODO(soon): does the grain need to be offline?

    var grainInfo = _.pick(grain, "appId", "appVersion", "title");
    writeFile(Path.join(token.filePath, "metadata"), Capnp.serialize(GrainInfo, grainInfo));

    var proc = ChildProcess.spawn(sandstormExe("minibox"), [
        // Mount root directory read-only, but hide /proc, /var, and /etc.
        "-r/=/", "-h/proc", "-h/var", "-h/etc",
        // Map /tmp to the backup tempdir, so that any other temp stuff is hidden.
        // Make this the current directory.
        "-w/tmp=" + token.filePath, "-d/tmp",
        // Map in things which we want to pack into the zip. We only need to do this because the
        // zip tool has no way to transform names when zipping, so we have to fool it into thinking
        // that these nodes are actually located where we want them.
        "-r/tmp/data=" + Path.join(SANDSTORM_GRAINDIR, grainId, "sandbox"),
        "-r/tmp/log=" + Path.join(SANDSTORM_GRAINDIR, grainId, "log"),
        // Run zip!
        "--", "zip", "-y", "-r", "backup.zip", "."], {stdio: "ignore"});
    proc.on("exit", function (code) {
      fut.return(code);
    });
    proc.on("error", function (err) {
      recursiveRmdirIfExists(token.filePath);
      fut.throw(new Meteor.Error(500, "Error in zipping procces"));
    });

    var code = fut.wait();
    if (code !== 0) {
      recursiveRmdirIfExists(token.filePath);
      throw new Meteor.Error(500, "Zip process failed.");
    }

    FileTokens.insert(token);

    return id;
  },

  restoreGrain: function (tokenId) {
    var token = FileTokens.findOne(tokenId);
    if (!token) {
      throw new Meteor.Error(403, "Unauthorized", "Token was not found");
    }

    this.unblock();

    var grainId = Random.id(22);
    var grainDir = Path.join(SANDSTORM_GRAINDIR, grainId);
    var grainSandboxDir = Path.join(grainDir, "sandbox");
    Fs.mkdirSync(grainDir);
    Fs.mkdirSync(grainSandboxDir);

    try {
      var fut = new Future();

      var proc = ChildProcess.spawn(sandstormExe("minibox"), [
          // Mount root directory read-only, but hide /proc, /var, and /etc.
          "-r/=/", "-h/proc", "-h/var", "-h/etc",
          // Map /tmp to the backup tempdir, so that any other temp stuff is hidden.
          // Make this the current directory.
          "-w/tmp=" + token.filePath, "-d/tmp",
          // Map /tmp/data to the grain's sandbox directory so data is unpacked directly to the
          // place we want.
          "-w/tmp/data=" + grainSandboxDir,
          "--", "unzip", "-o", "backup.zip"], {stdio: "ignore"});
      proc.on("exit", function (code) {
        fut.return(code);
      });
      proc.on("error", function (err) {
        fut.throw(new Meteor.Error(500, "Error in unzipping procces"));
      });

      var code = fut.wait();
      if (code !== 0) {
        Meteor.call("cleanupToken", tokenId);
        throw new Meteor.Error(500, "Unzip process failed.");
      }

      var metadata = Path.join(token.filePath, "metadata");
      var grainInfoBuf = readFile(metadata);
      var grainInfo = Capnp.parse(GrainInfo, grainInfoBuf);
      if (!grainInfo.appId) {
          throw new Meteor.Error(500,
                                 "Metadata object for uploaded grain has no AppId");
      }

      var action = UserActions.findOne({appId: grainInfo.appId, userId: this.userId});
      if (!action) {
        throw new Meteor.Error(500,
                               "App id for uploaded grain not installed",
                               "App Id: " + grainInfo.appId);
      }
      if (action.appVersion < grainInfo.appVersion) {
        throw new Meteor.Error(500,
                               "App version for uploaded grain is newer than any " +
                               "installed version. You need to upgrade your app first",
                               "New version: " + grainInfo.appVersion +
                               ", Old version: " + action.appVersion);
      }

      Grains.insert({
        _id: grainId,
        packageId: action.packageId,
        appId: action.appId,
        appVersion: action.appVersion,
        userId: this.userId,
        title: grainInfo.title
      });
    } catch (err) {
      recursiveRmdirIfExists(grainDir);
      throw err;
    }

    Meteor.call("cleanupToken", tokenId);
    return grainId;
  },

  cleanupToken: function (tokenId) {
    var token = FileTokens.findOne(tokenId);
    if (!token) {
      return;
    }
    recursiveRmdirIfExists(token.filePath);
    FileTokens.remove({_id: tokenId});
  }
});

doGrainUpload = function (stream) {
  return new Promise(function (resolve, reject) {
    var id = Random.id();
    var token = {
      _id: id,
      filePath: Path.join(TMPDIR, "/", id),
      timestamp: new Date()
    };
    mkdir(token.filePath);
    var backupFile = Path.join(token.filePath, "backup.zip");

    var file = Fs.createWriteStream(backupFile);

    stream.on("end", function () {
      try {
        file.end();
        resolve(token);
      } catch (err) {
        recursiveRmdirIfExists(token.filePath);
        reject(err);
      }
    });
    stream.on("error", function (err) {
      // TODO(soon):  This event does"t seem to fire if the user leaves the page mid-upload.
      try {
        file.end();
        recursiveRmdirIfExists(token.filePath);
        reject(err);
      } catch (err2) {
        recursiveRmdirIfExists(token.filePath);
        reject(err2);
      }
    });

    stream.pipe(file);
  });
};

Router.map(function () {
  this.route("downloadBackup", {
    where: "server",
    path: "/downloadBackup/:tokenId",
    action: function () {
      var fut = new Future();
      var response = this.response;
      var token = FileTokens.findOne(this.params.tokenId);
      var backupFile = Path.join(token.filePath, "backup.zip");

      var fileSize, file;
      try {
        fileSize = Fs.statSync(backupFile).size;
        file = Fs.createReadStream(backupFile);
      } catch (error) {
        response.writeHead(404, {"Content-Type": "text/plain"});
        return response.end("File does not exist");
      }

      file.on("error", function (error) {
        // TODO(someday): this might not work if error occurs after open?
        response.writeHead(404, {"Content-Type": "text/plain"});
        response.write("Failed to archive");
        fut.return();
      });

      file.on("end", function () {
        fut.return();
      });

      file.on("open", function () {
        var filename = token.name + ".zip";
        // Make first character be alpha-numeric
        filename = filename.replace(/^[^A-Za-z0-9_]/, "_");
        // Remove non filesystem characters
        filename = filename.replace(new RegExp("[\\\\/:*?\"<>|]","g"), "");

        response.writeHead(200, headers = {
          "Content-Length": fileSize,
          "Content-Type": "application/zip",
          "Content-Disposition": "attachment;filename=\"" + filename + "\""
        });
      });

      file.pipe(this.response);

      fut.wait();

      Meteor.call("cleanupToken", this.params.tokenId);
      return this.response.end();
    }
  });

  this.route("uploadBackup", {
    where: "server",
    path: "/uploadBackup",
    action: function () {
      if (this.request.method === "POST") {
        var request = this.request;
        try {
          var self = this;
          var token = promiseToFuture(doGrainUpload(request)).wait();
          FileTokens.insert(token);
          self.response.writeHead(200, {
            "Content-Length": token._id.length,
            "Content-Type": "text/plain"
          });
          self.response.write(token._id);
          self.response.end();
        } catch(error) {
          console.error(error.stack);
          self.response.writeHead(500, {
            "Content-Type": "text/plain"
          });
          self.response.write(error.stack);
          self.response.end();
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
