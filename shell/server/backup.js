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

var ChildProcess = Npm.require("child_process");
var Fs = Npm.require("fs");
var Future = Npm.require("fibers/future");
var Path = Npm.require("path");

var GrainInfo = Capnp.importSystem("sandstorm/grain.capnp").GrainInfo;

var TMPDIR = "/tmp";
var TOKEN_CLEANUP_MINUTES = 15;
var TOKEN_CLEANUP_TIMER = TOKEN_CLEANUP_MINUTES * 60 * 1000;

Meteor.startup(function () {
  // Cleanup tokens every TOKEN_CLEANUP_MINUTES
  Meteor.setInterval(function () {
    var queryDate = new Date();
    queryDate.setMinutes(queryDate.getMinutes() - TOKEN_CLEANUP_MINUTES);

    FileTokens.find({timestamp: {$lt: queryDate}}).forEach(function (token) {
      Meteor.call('cleanupToken', token._id);
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

    var fut = new Future();

    var id = Random.id(22);
    var token = {
      _id: id,
      filePath: Path.join(TMPDIR, "/", id),
      timestamp: new Date(),
      name: grain.title
    };

    Fs.mkdirSync(token.filePath);
    var backupFile = Path.join(token.filePath, 'backup.zip');
    var dataDir = Path.join(token.filePath, 'data');
    var outLog = Path.join(token.filePath, 'log');
    var metadata = Path.join(token.filePath, 'metadata');

    var grainDir = Path.join(SANDSTORM_GRAINDIR, grainId, "sandbox");
    var inLog = Path.join(SANDSTORM_GRAINDIR, grainId, "log");
    FsExtra.copySync(grainDir, dataDir);  // TODO: does the grain need to be offline?
    FsExtra.copySync(inLog, outLog);

    var grainInfo = _.pick(grain, 'packageId', 'appId', 'appVersion', 'title');
    Fs.writeFileSync(metadata, Capnp.serialize(GrainInfo, grainInfo));

    var proc = ChildProcess.spawn("zip", ["-r", backupFile, "."], {cwd: token.filePath});
    proc.on("exit", function (code) {
      fut.return(code);
    });
    proc.on("error", function (err) {
      FsExtra.removeSync(token.filePath);
      fut.throw(new Meteor.Error(500, 'Error in zipping procces'));
    });

    var code = fut.wait();
    if (code !== 0) {
      FsExtra.removeSync(token.filePath);
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

    var fut = new Future();

    var backupFile = Path.join(token.filePath, 'backup.zip');

    var proc = ChildProcess.spawn('unzip', ['-o', backupFile], {cwd: token.filePath});
    proc.on("exit", function (code) {
      fut.return(code);
    });
    proc.on("error", function (err) {
      fut.throw(new Meteor.Error(500, 'Error in unzipping procces'));
    });

    var code = fut.wait();
    if (code !== 0) {
      Meteor.call('cleanupToken', tokenId);
      throw new Meteor.Error(500, "Unzip process failed.");
    }

    var metadata = Path.join(token.filePath, 'metadata');
    var grainInfoBuf = Fs.readFileSync(metadata);
    var grainInfo = Capnp.parse(GrainInfo, grainInfoBuf);

    var package = Packages.findOne(grainInfo.packageId);
    var grainId = Random.id(22);  // 128 bits of entropy

    var grainDir = Path.join(SANDSTORM_GRAINDIR, grainId, "sandbox");
    var dataDir = Path.join(token.filePath, 'data');
    FsExtra.removeSync(grainDir);
    FsExtra.copySync(dataDir, grainDir);

    Grains.insert({
      _id: grainId,
      packageId: grainInfo.packageId,
      appId: grainInfo.appId,
      appVersion: grainInfo.appVersion,
      userId: this.userId,
      title: grainInfo.title
    });

    Meteor.call('cleanupToken', tokenId);
    return grainId;
  },

  cleanupToken: function (tokenId) {
    var token = FileTokens.findOne(tokenId);
    if (!token) {
      throw new Meteor.Error(500, "Token not found", "tokenId: " + tokenId);
    }
    FsExtra.removeSync(token.filePath);
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
    Fs.mkdirSync(token.filePath);
    var backupFile = Path.join(token.filePath, 'backup.zip');

    var file = Fs.createWriteStream(backupFile);

    stream.on("end", function () {
      try {
        file.end();
        resolve(token);
      } catch (err) {
        FsExtra.removeSync(token.filePath);
        reject(err);
      }
    });
    stream.on("error", function (err) {
      // TODO(soon):  This event does"t seem to fire if the user leaves the page mid-upload.
      try {
        file.end();
        FsExtra.removeSync(token.filePath);
        reject(err);
      } catch (err2) {
        FsExtra.removeSync(token.filePath);
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
      var backupFile = Path.join(token.filePath, 'backup.zip');

      var fileSize, file;
      try {
        fileSize = Fs.statSync(backupFile).size;
        file = Fs.createReadStream(backupFile);
      } catch (error) {
        response.writeHead(404, {"Content-Type": "text/plain"});
        return response.end("File does not exist");
      }

      file.on("error", function (error) {
        // TODO: this might not work if error occurs after open?
        response.writeHead(404, {"Content-Type": "text/plain"});
        response.write("Failed to archive");
        fut.return();
      });

      file.on("end", function () {
        fut.return();
      });

      file.on("open", function () {
        var filename = token.name + '.zip';
        // Make first character be alpha-numeric
        filename = filename.replace(/^[^A-Za-z0-9_]/, '_');
        // Remove non filesystem characters
        filename = filename.replace(new RegExp("[\\\\/:*?\"<>|]","g"), '');

        response.writeHead(200, headers = {
          "Content-Length": fileSize,
          "Content-Type": "application/octet-stream",
          "Content-Disposition": "attachment; filename=" + filename
        });
      });

      file.pipe(this.response);

      fut.wait();

      Meteor.call('cleanupToken', this.params.tokenId);
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