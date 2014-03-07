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

var Fs = Npm.require("fs");
var Path = Npm.require("path");
var Crypto = Npm.require("crypto");
var ChildProcess = Npm.require("child_process");
var Http = Npm.require("http");
var Capnp = Npm.require("sandstorm/capnp");

var Manifest = Capnp.import("sandstorm/grain.capnp").Manifest;

var APPDIR = "/var/sandstorm/apps";
var PKGDIR = "/var/sandstorm/pkgs";
var DOWNLOADDIR = "/var/sandstorm/downloads";

var installers = {};

function recursiveRmdir(dir) {
  Fs.readdirSync(dir).forEach(function (filename) {
    filename = Path.join(dir, filename);
    if(Fs.lstatSync(filename).isDirectory()) {
      recursiveRmdir(filename);
    } else {
      Fs.unlinkSync(filename);
    }
  });
  Fs.rmdirSync(dir);
};

var inMeteor = Meteor.bindEnvironment(function (self, callback) { callback.call(self); });
// Function which runs some callback in a Meteor environment unattached to any particular incoming
// request.  The app installation process happens in the background, completing asynchornously, but
// we need to be in a Meteor scope to update Mongo, so that's what this does.

startInstall = function (appid, url, callback) {
  if (!(appid in installers)) {
    var installer = new AppInstaller(appid, url);
    installers[appid] = installer;
    installer.start();
  }
}

cancelDownload = function (appid) {
  var installer = installers[appid];

  // Don't do anything unless a download is in progress.
  if (installer && installer.downloadRequest) {
    // OK, effect cancellation by faking an error.
    installer.wrapCallback(function () {
      throw new Error("Canceled");
    })();
  }
}

function AppInstaller(appid, url, callback) {
  this.appid = appid;
  this.url = url;
  this.urlHash = Crypto.createHash("sha256").update(url).digest("hex").slice(0, 32);
  this.downloadPath = Path.join(DOWNLOADDIR, this.urlHash + ".downloading");
  this.unverifiedPath = Path.join(DOWNLOADDIR, this.urlHash + ".unverified");
  this.verifiedPath = Path.join(DOWNLOADDIR, this.appid + ".verified");
  this.unpackedPath = Path.join(APPDIR, this.appid);
  this.unpackingPath = this.unpackedPath + ".unpacking";
  this.failed = false;
  this.callback = callback;
}

AppInstaller.prototype.updateProgress = function (status, progress, error, manifest) {
  this.status = status;
  this.progress = progress || -1;
  this.error = error;
  this.manifest = manifest || null;

  inMeteor(this, function () {
    Apps.update({appid: this.appid}, {$set: {
      status: this.status,
      progress: this.progress,
      error: this.error ? this.error.message : null,
      manifest: this.manifest
    }});
  });
}

AppInstaller.prototype.wrapCallback = function (method) {
  var self = this;
  return function () {
    if (self.failed) return;
    try {
      return method.apply(self, _.toArray(arguments));
    } catch (err) {
      self.failed = true;
      self.cleanup();
      self.updateProgress("failed", 0, err);
      delete installers[self.appid];
      console.error("Failed to install app:", err.stack);
    }
  }
}

AppInstaller.prototype.cleanup = function () {
  if (Fs.existsSync(this.unpackingPath)) {
    try {
      recursiveRmdir(this.unpackingPath);
    } catch (err) {
      console.error("Error while trying to delete stale temp dir " + this.unpackingPath + ":", err);
    }
  }

  if (Fs.existsSync(this.unverifiedPath)) {
    try {
      Fs.unlinkSync(this.unverifiedPath);
    } catch (err) {
      console.error("Error while trying to delete stale download file " + this.unverifiedPath + ":",
                    err);
    }
  }

  if (this.downloadRequest) {
    try { this.downloadRequest.abort(); } catch (err) {}
    delete this.downloadRequest;
  }
}

AppInstaller.prototype.start = function () {
  return this.wrapCallback(function () {
    this.cleanup();
    if (Fs.existsSync(this.unpackedPath)) {
      this.doAnalyze();
    } else if (Fs.existsSync(this.verifiedPath)) {
      this.doUnpack();
    } else if (Fs.existsSync(this.unverifiedPath)) {
      this.doVerify();
    } else {
      this.doDownload();
    }
  })();
}

AppInstaller.prototype.doDownload = function () {
  console.log("Downloading app:", this.url);
  this.updateProgress("download");

  var out = Fs.createWriteStream(this.downloadPath);
  var broken = false;

  var request = Http.get(this.url, this.wrapCallback(function (response) {
    if (response.statusCode !== 200) {
      throw new Error("Download failed with HTTP status code: " + response.statusCode);
    }

    var bytesExpected = undefined;
    var bytesReceived = 0;

    if ("content-length" in response.headers) {
      bytesExpected = parseInt(response.headers["content-length"]);
    }

    var done = false;

    var updateDownloadProgress = _.throttle(this.wrapCallback(function () {
      if (!done) {
        if (bytesExpected) {
          this.updateProgress("download", bytesReceived / bytesExpected);
        } else {
          this.updateProgress("download", bytesReceived);
        }
      }
    }), 1000);

    response.on("data", this.wrapCallback(function (chunk) {
      out.write(chunk);
      bytesReceived += chunk.length;
      updateDownloadProgress();
    }));
    response.on("end", this.wrapCallback(function () {
      done = true;
      out.end();
      delete this.downloadRequest;

      if (!this.failed) {
        Fs.renameSync(this.downloadPath, this.unverifiedPath);
        this.doVerify();
      }
    }));
  }));

  this.downloadRequest = request;

  request.on("error", this.wrapCallback(function (err) {
    Fs.unlinkSync(this.downloadPath);
    throw err;
  }));
  out.on("error", this.wrapCallback(function (err) {
    try { Fs.unlinkSync(this.downloadPath); } catch (e) {}
    throw err;
  }));
}

AppInstaller.prototype.doVerify = function () {
  console.log("Verifying app:", this.unverifiedPath);
  this.updateProgress("verify");

  var input = Fs.createReadStream(this.unverifiedPath);
  var hasher = Crypto.createHash("sha256");

  input.on("data", this.wrapCallback(function (chunk) {
    hasher.update(chunk);
  }));
  input.on("end", this.wrapCallback(function () {
    if (hasher.digest("hex").slice(0, 32) === this.appid) {
      Fs.renameSync(this.unverifiedPath, this.verifiedPath);
      this.doUnpack();
    } else {
      // This file is bunk.  Delete it.
      Fs.unlinkSync(this.unverifiedPath);
      throw new Error("Package hash did not match.");
    }
  }));
}

AppInstaller.prototype.doUnpack = function() {
  console.log("Unpacking app:", this.verifiedPath);
  this.updateProgress("unpack");

  Fs.mkdirSync(this.unpackingPath);

  var child = ChildProcess.spawn("unzip", ["-q", this.verifiedPath], {
    cwd: this.unpackingPath,
    stdio: "inherit"
  });

  child.on("exit", this.wrapCallback(function (code, sig) {
    if (code !== 0) {
      throw new Error("Unzip failed.");
    }

    Fs.renameSync(this.unpackingPath, this.unpackedPath);
    this.doAnalyze();
  }));
}

AppInstaller.prototype.doAnalyze = function() {
  console.log("Analyzing app:", this.verifiedPath);
  this.updateProgress("analyze");

  var manifestFilename = Path.join(this.unpackedPath, "sandstorm-manifest");
  if (!Fs.existsSync(manifestFilename)) {
    throw new Error("Package missing manifest.");
  }

  var manifest = Capnp.parse(Manifest, Fs.readFileSync(manifestFilename));

  // Success.
  this.done(manifest);
}

AppInstaller.prototype.done = function(manifest) {
  console.log("App ready:", this.unpackedPath);
  this.updateProgress("ready", 1, undefined, manifest);
}
