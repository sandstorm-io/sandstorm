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

var TMPDIR = "/tmp";
// TODO: add timer that clears tokens

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
      filePath: Path.join(TMPDIR, "/", id + ".zip"),
      timestamp: new Date()
    };

    var grainDir = Path.join(SANDSTORM_GRAINDIR, grainId, "sandbox");
    var proc = ChildProcess.spawn("zip", ["-r", token.filePath, "."], {cwd: grainDir});
    proc.on("exit", function(code) {
      fut.return(code);
    });
    proc.on("error", function(err) {
      fs.unlinkSync(token.filePath);
      fut.throw(err);
    });

    var code = fut.wait();
    if (code !== 0) {
      fs.unlinkSync(token.filePath);
      throw new Error("Zip process failed.");
    }

    FileTokens.insert(token);
    return id;
  },
  restoreGrain: function (tokenId, grainId) {
    check(grainId, String);
    var grain = Grains.findOne(grainId);
    if (!grain || !this.userId || grain.userId !== this.userId) {
      throw new Meteor.Error(403, "Unauthorized", "User is not the owner of this grain");
    }

    var token = FileTokens.findOne(tokenId);
    if (!token) {
      throw new Meteor.Error(403, "Unauthorized", "Token was not found");
    }

    var fut = new Future();

    // TODO: stop grain
    var grainDir = Path.join(SANDSTORM_GRAINDIR, grainId, "sandbox");

    // TODO: rm directory first
    var proc = ChildProcess.spawn('unzip', ['-o', token.filePath], {cwd: grainDir});
    proc.on("exit", function(code) {
      fut.return(code);
    });
    proc.on("error", function(err) {
      fut.throw(err);
    });

    var code = fut.wait();
    if (code !== 0) {
      fs.unlinkSync(token.filePath);
      throw new Error("Unzip process failed.");
    }

    // TODO: Clean up file token?
  }


});

doGrainUpload = function (stream) {
  return new Promise(function (resolve, reject) {
    var id = Random.id();
    var token = {
      _id: id,
      filePath: Path.join(TMPDIR, "/", id + ".zip"),
      timestamp: new Date()
    };

    var file = Fs.createWriteStream(token.filePath);

    stream.on("end", function () {
      try {
        file.end();
        resolve(token);
      } catch (err) {
        reject(err);
      }
    });
    stream.on("error", function (err) {
      // TODO(soon):  This event does"t seem to fire if the user leaves the page mid-upload.
      try {
        file.end();
        Fs.unlinkSync(token.filePath);
        reject(err);
      } catch (err2) {
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
    action: function() {
      var fut = new Future();
      var response = this.response;
      var token = FileTokens.findOne(this.params.tokenId);

      var fileSize, file;
      try {
        fileSize = Fs.statSync(token.filePath).size;
        file = Fs.createReadStream(token.filePath);
      } catch (error) {
        response.writeHead(404, {"Content-Type": "text/plain"});
        return response.end("File does not exist");
      }

      file.on("error", function (error) {
        // TODO: this might not work if error occurs after open?
        response.writeHead(404, {"Content-Type": "text/plain"});
        response.end("Failed to archive");
        fut.return();
      });

      file.on("end", function () {
        fut.return();
      });

      file.on("open", function () {
        response.writeHead(200, headers = {
          "Content-Length": fileSize,
          "Content-Type": "application/octet-stream",
          "Content-Disposition": "attachment; filename=" + Path.basename(token.filePath)
        });
      });

      file.pipe(this.response);

      fut.wait();

      return this.response.end();
    }
  });

  this.route("uploadBackup", {
    where: "server",
    path: "/uploadBackup",
    action: function() {
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