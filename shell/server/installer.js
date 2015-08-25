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
var Https = Npm.require("https");
var Url = Npm.require("url");
var Promise = Npm.require("es6-promise").Promise;
var Capnp = Npm.require("capnp");

var Manifest = Capnp.importSystem("sandstorm/package.capnp").Manifest;

var installers = {};
// To protect against race conditions, we require that each row in the Packages
// collection have at most one writer at a time, as tracked by this `installers`
// map. Each key is a package ID and each value is either an AppInstaller object
// or the string "uninstalling", indicating that some fiber is working on
// uninstalling the package.

Meteor.methods({
  deleteUnusedPackages: function (appId) {
    check(appId, String);
    Packages.find({appId:appId}).forEach(function (package) {deletePackage(package._id)});
  },
});

deletePackage = function (packageId) {
  if (packageId in installers) {
    return;
  }

  installers[packageId] = "uninstalling";

  try {
    var action = UserActions.findOne({packageId:packageId});
    var grain = Grains.findOne({packageId:packageId});
    if (!grain && !action) {
      Packages.update({_id:packageId}, {$set: {status:"delete"}});
      waitPromise(sandstormBackend.deletePackage(packageId));
      var package = Packages.findAndModify({
        query: {_id: packageId},
        remove: true
      });

      // Clean up assets (icon, etc).
      getAllManifestAssets(package.manifest).forEach(function (assetId) {
        globalDb.unrefStaticAsset(assetId);
      });
    }
    delete installers[packageId];
  } catch (error) {
    delete installers[packageId];
    throw error;
  }
}

startInstall = function (packageId, url, fromBeginning, appId) {
  if (packageId in installers) {
    return;
  }

  var installer = new AppInstaller(packageId, url, appId);
  installers[packageId] = installer;

  if (fromBeginning) {
    try {
      Packages.upsert({ _id: packageId}, {$set: {status: "download", progress: 0 }});
    } catch (error) {
      delete installers[packageId];
      throw error;
    }
  }

  installer.start();
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

    var backendStream = sandstormBackend.installPackage().stream;
    var hasher = Crypto.createHash("sha256");

    stream.on("data", function (chunk) {
      try {
        hasher.update(chunk);
        backendStream.write(chunk);
      } catch (err) {
        reject(err);
      }
    });
    stream.on("end", function () {
      try {
        backendStream.done();
        var packageId = hasher.digest("hex").slice(0, 32);
        resolve(backendStream.saveAs(packageId).then(function () {
          return packageId;
        }));
        backendStream.close();
      } catch (err) {
        reject(err);
      }
    });
    stream.on("error", function (err) {
      // TODO(soon):  This event does't seem to fire if the user leaves the page mid-upload.
      try {
        backendStream.close();
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
  this.failed = false;
  this.appId = appId;

  // Serializes database writes.
  this.writeChain = Promise.resolve();
}

function extractManifestAssets(manifest) {
  var metadata = manifest.metadata;
  if (!metadata) return;

  var icons = metadata.icons;
  if (icons) {
    var handleIcon = function (icon) {
      if (icon.svg) {
        icon.assetId = globalDb.addStaticAsset({mimeType: "image/svg+xml"}, icon.svg);
        icon.format = "svg";
        delete icon.svg;
        return true;
      } else if (icon.png) {
        // Use the 1x version for "normal" DPI, unless 1x isn't provided, in which case use 2x.
        var normalDpi = icon.png.dpi1x || icon.png.dpi2x;
        if (!normalDpi) return false;
        icon.format = "png";
        icon.assetId = globalDb.addStaticAsset({mimeType: "image/png"}, normalDpi);

        if (icon.png.dpi1x && icon.png.dpi2x) {
          // Icon specifies both resolutions, so also record a 2x DPI option.
          icon.assetId2xDpi = globalDb.addStaticAsset({mimeType: "image/png"}, icon.png.dpi2x);
        }
        delete icon.png;
        return true;
      } else {
        // Unknown icon. Filter it.
        return false;
      }
    }

    if (icons.appGrid && !handleIcon(icons.appGrid)) delete icons.appGrid;
    if (icons.grain && !handleIcon(icons.grain)) delete icons.grain;

    // We don't need the market icons.
    if (icons.market) delete icons.market;
    if (icons.marketBig) delete icons.marketBig;
  }

  var handleLocalizedText = function (text) {
    if (text.defaultText) {
      text.defaultTextAssetId = globalDb.addStaticAsset({mimeType: "text/plain"}, text.defaultText);
      delete text.defaultText;
    }

    if (text.localizations) {
      text.localizations.forEach(function (localization) {
        if (localization.text) {
          localization.assetId = globalDb.addStaticAsset(
              {mimeType: "text/plain"}, localization.text);
          delete localization.text;
        }
      });
    }
  }

  var license = metadata.license;
  if (license) {
    if (license.proprietary) license.proprietary = handleLocalizedText(license.proprietary);
    if (license.publicDomain) license.publicDomain = handleLocalizedText(license.proprietary);
    if (license.notices) license.notices = handleLocalizedText(license.notices);
  }

  var author = metadata.author;
  if (author) {
    // We remove the PGP signature since it was already verified down to a key ID in the back-end.
    if (author.pgpSignature) delete author.pgpSignature;
    if (author.pgpPublicKey) delete author.pgpPublicKey;
  }

  // Perhaps used by the "about" page?
  if (metadata.description) metadata.description = handleLocalizedText(metadata.description);

  // Screenshots are for app marketing; we don't use them post-install.
  if (metadata.screenshots) delete metadata.screenshots;

  // We might allow the user to view the changelog.
  if (metadata.changeLog) metadata.changeLog = handleLocalizedText(metadata.changeLog);
}

function getAllManifestAssets(manifest) {
  // Returns a list of all asset IDs in the given manifest.

  var metadata = manifest.metadata;
  if (!metadata) return [];

  var result = [];

  var icons = metadata.icons;
  if (icons) {
    var handleIcon = function (icon) {
      if (icon.assetId) {
        result.push(icon.assetId);
      }
    }

    if (icons.appGrid) handleIcon(icons.appGrid);
    if (icons.grain) handleIcon(icons.grain);
  }

  var handleLocalizedText = function (text) {
    if (text.defaultTextAssetId) {
      result.push(defaultTextAssetId);
    }

    if (text.localizations) {
      text.localizations.forEach(function (localization) {
        if (localization.assetId) {
          result.push(localization.assetId);
        }
      });
    }
  }

  var license = metadata.license;
  if (license) {
    if (license.proprietary) handleLocalizedText(license.proprietary);
    if (license.publicDomain) handleLocalizedText(license.publicDomain);
    if (license.notices) handleLocalizedText(license.notices);
  }

  if (metadata.description) handleLocalizedText(metadata.description);
  if (metadata.changeLog) handleLocalizedText(metadata.changeLog);

  return result;
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

  // The callback passed to inMeteor() runs in a new fiber. We need to make sure database writes
  // occur in exactly the order in which we generate them, so we use a promise chain to serialize
  // them.
  this.writeChain = this.writeChain.then(function () {
    return inMeteor(function () {
      if (manifest) extractManifestAssets(manifest);

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
      self.writeChain = self.writeChain.then(function() {
        delete installers[self.packageId];
      });
      console.error("Failed to install app:", err.stack);
    }
  }
}

AppInstaller.prototype.cleanup = function () {
  if (this.uploadStream) {
    try { this.uploadStream.close(); } catch (err) {}
    delete this.uploadStream;
  }

  if (this.downloadRequest) {
    try { this.downloadRequest.abort(); } catch (err) {}
    delete this.downloadRequest;
  }
}

AppInstaller.prototype.start = function () {
  return this.wrapCallback(function () {
    this.cleanup();

    sandstormBackend.tryGetPackage(this.packageId)
        .then(this.wrapCallback(function(info) {
      if (info.appId) {
        this.appId = info.appId;
        this.done(info.manifest);
      } else {
        this.doDownload();
      }
    }), this.wrapCallback(function (err) {
      throw err;
    }));
  })();
}

AppInstaller.prototype.doDownload = function () {
  if (!this.url) {
    throw new Error("Unknown package ID, and no URL was provided.")
  }

  console.log("Downloading app:", this.url);
  this.updateProgress("download");

  this.uploadStream = sandstormBackend.installPackage().stream;
  return this.doDownloadTo(this.uploadStream);
}

AppInstaller.prototype.doDownloadTo = function (out) {
  var url = Url.parse(this.url);
  var options = {
    hostname: url.hostname,
    port: url.port,
    path: url.path
  };

  var protocol;
  if (url.protocol === "http:") {
    protocol = Http;
  } else if (url.protocol === "https:") {
    // Since we will verify the download against a hash anyway, we don't need to verify the server's
    // certificate. In fact, the only reason we support HTTPS at all here is because some servers
    // refuse to serve over HTTP (which is, in general, a good thing). Skipping the certificate check
    // here is helpful in that it means we don't have to worry about having a reasonable list of trusted
    // CAs available to Sandstorm.
    options.rejectUnauthorized = false;
    protocol = Https;
  } else {
    throw new Error("Protocol not supported: " + url.protocol);
  }

  // TODO(security):  It could arguably be a security problem that it's possible to probe the
  //   server's local network (behind any firewalls) by presenting URLs here.
  var request = protocol.get(options, this.wrapCallback(function (response) {
    if (response.statusCode === 301 ||
        response.statusCode === 302 ||
        response.statusCode === 303 ||
        response.statusCode === 307 ||
        response.statusCode === 308) {
      // Got redirect. Follow it.
      this.url = Url.resolve(this.url, response.headers["location"]);
      this.doDownloadTo(out);
      return;
    }

    if (response.statusCode !== 200) {
      throw new Error("Download failed with HTTP status code: " + response.statusCode);
    }

    var bytesExpected = undefined;
    var bytesReceived = 0;

    if ("content-length" in response.headers) {
      bytesExpected = parseInt(response.headers["content-length"]);
    }

    var done = false;
    var hasher = Crypto.createHash("sha256");

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
      hasher.update(chunk);
      out.write(chunk);
      bytesReceived += chunk.length;
      updateDownloadProgress();
    }));
    response.on("end", this.wrapCallback(function () {
      out.done();

      if (hasher.digest("hex").slice(0, 32) !== this.packageId) {
        throw new Error("Package hash did not match.");
      }

      done = true;
      delete this.downloadRequest;

      this.updateProgress("unpack");
      out.saveAs(this.packageId).then(this.wrapCallback(function (info) {
        this.appId = info.appId;
        this.done(info.manifest);
      }), this.wrapCallback(function (err) {
        throw err;
      }));
    }));

    response.on("error", this.wrapCallback(function (err) { throw err; }));
  }));

  this.downloadRequest = request;

  request.on("error", this.wrapCallback(function (err) { throw err; }));
}

AppInstaller.prototype.done = function(manifest) {
  console.log("App ready:", this.packageId);
  this.updateProgress("ready", 1, undefined, manifest);
  var self = this;
  self.writeChain = self.writeChain.then(function() {
    delete installers[self.packageId];
  });
}
