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

var Fs = Npm.require("fs");
var Path = Npm.require("path");
var Crypto = Npm.require("crypto");
var ChildProcess = Npm.require("child_process");
var Http = Npm.require("http");

var Manifest = Capnp.importSystem("sandstorm/package.capnp").Manifest;

var installers = {};

recursiveRmdir = function (dir) {
  // TODO(cleanup):  Put somewhere resuable, since proxy.js uses it.

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

startInstall = function (packageId, url, appId) {
  // appId is optional and passed only if it is already known (e.g. verified during a previous
  // installation attempt).

  if (!(packageId in installers)) {
    var installer = new AppInstaller(packageId, url, appId);
    installers[packageId] = installer;
    installer.start();
  }
}

cancelDownload = function (packageId) {
  var installer = installers[packageId];

  // Don't do anything unless a download is in progress.
  if (installer && installer.downloadRequest) {
    // OK, effect cancellation by faking an error.
    installer.wrapCallback(function () {
      throw new Error("Canceled");
    })();
  }
}

doClientUpload = function (stream) {
  return new Promise(function (resolve, reject) {
    var id = Random.id();
    var tmpPath = Path.join(SANDSTORM_DOWNLOADDIR, id + ".downloading");
    var file = Fs.createWriteStream(tmpPath);
    var hasher = Crypto.createHash("sha256");

    stream.on("data", function (chunk) {
      try {
        hasher.update(chunk);
        file.write(chunk);
      } catch (err) {
        reject(err);
      }
    });
    stream.on("end", function () {
      try {
        file.end();
        var packageId = hasher.digest("hex").slice(0, 32);
        var verifiedPath = Path.join(SANDSTORM_DOWNLOADDIR, packageId + ".verified");
        if (Fs.existsSync(verifiedPath)) {
          Fs.unlinkSync(tmpPath);
        } else {
          Fs.renameSync(tmpPath, verifiedPath);
        }
        resolve(packageId);
      } catch (err) {
        reject(err);
      }
    });
    stream.on("error", function (err) {
      // TODO(soon):  This event does't seem to fire if the user leaves the page mid-upload.
      try {
        file.end();
        Fs.unlinkSync(tmpPath);
        reject(err);
      } catch (err2) {
        reject(err2);
      }
    });
  });
}

function AppInstaller(packageId, url, appId) {
  this.packageId = packageId;
  this.url = url;
  this.urlHash = url && Crypto.createHash("sha256").update(url).digest("hex").slice(0, 32);
  this.downloadPath = Path.join(SANDSTORM_DOWNLOADDIR, this.urlHash + ".downloading");
  this.unverifiedPath = Path.join(SANDSTORM_DOWNLOADDIR, this.urlHash + ".unverified");
  this.verifiedPath = Path.join(SANDSTORM_DOWNLOADDIR, this.packageId + ".verified");
  this.unpackedPath = Path.join(SANDSTORM_APPDIR, this.packageId);
  this.unpackingPath = this.unpackedPath + ".unpacking";
  this.failed = false;
  this.appId = appId;
}

AppInstaller.prototype.updateProgress = function (status, progress, error, manifest) {
  // TODO(security):  On error, we should actually delete the package from the database and only
  //   display the error to whomever was watching at the time.  Otherwise it's easy to confuse
  //   people by "pre-failing" packages.  (Actually, perhaps if a user tries to download an
  //   already-downloading package but specifies a different URL, we really should initiate an
  //   entirely separate download...  but cancel it if the first download succeeds.)

  this.status = status;
  this.progress = progress || -1;
  this.error = error;
  this.manifest = manifest || null;

  var self = this;

  inMeteor(function () {
    Packages.update(self.packageId, {$set: {
      status: self.status,
      progress: self.progress,
      error: self.error ? self.error.message : null,
      manifest: self.manifest,
      appId: self.appId
    }});
  }).catch (function (err) {
    console.error(err.stack);
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
      delete installers[self.packageId];
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
  if (!this.url) {
    throw new Error("Unknown package ID, and no URL was provided.")
  }

  console.log("Downloading app:", this.url);
  this.updateProgress("download");

  var out = Fs.createWriteStream(this.downloadPath);
  var broken = false;

  // TODO(security):  It could arguably be a security problem that it's possible to probe the
  //   server's local network (behind any firewalls) by presenting URLs here.
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
      out.end(this.wrapCallback(function (err) {
        if (err) throw err;

        done = true;
        delete this.downloadRequest;

        if (!this.failed) {
          Fs.renameSync(this.downloadPath, this.unverifiedPath);
          this.doVerify();
        }
      }));
    }));

    response.on("error", this.wrapCallback(function (err) { throw err; }));
    out.on("error", this.wrapCallback(function (err) { throw err; }));
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
    if (hasher.digest("hex").slice(0, 32) === this.packageId) {
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

  var child = ChildProcess.spawn(sandstormExe("spk"),
      ["unpack", this.verifiedPath, this.unpackingPath], {
    stdio: ["ignore", "pipe", process.stderr]
  });

  // Read in app ID from the app's stdout pipe.
  var appId = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", function (text) {
    appId = appId + text;
  });

  child.on("close", this.wrapCallback(function (code, sig) {
    if (code !== 0) {
      throw new Error("Unpack failed.");
    }

    this.appId = appId.trim();

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

  // TODO(security):  Refuse to parse overly large manifests.  Also make sure the Cap'n Proto layer
  //   sets the traversal limit appropriately.
  var manifest = Capnp.parse(Manifest, Fs.readFileSync(manifestFilename));

  if (!this.appId) {
    // TODO(someday):  Deal with this case?  It should never happen, because:
    // - If we did doUnpack(), we should have found the appId there.
    // - If we skipped it, it is only because we had the appId previously, so we should have
    //   received the old appId in the constructor.
    throw new Error(
        "Somehow this package has been unpacked previously but we don't have its appId.  " +
        "This should be impossible.  Unfortunately, I don't know how to deal with this state.  " +
        "Please report this bug to the sandstorm developers.  As a work-around, if you are " +
        "the system administrator, try deleting this package's directory from " +
        "$SANDSTORM_HOME/var/sandstorm/apps.");
  }

  // Success.
  this.done(manifest);
}

AppInstaller.prototype.done = function(manifest) {
  console.log("App ready:", this.unpackedPath);
  this.updateProgress("ready", 1, undefined, manifest);
}
