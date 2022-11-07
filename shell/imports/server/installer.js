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

import Crypto from "crypto";
import { pipeline, Writable } from "stream";

import { Meteor } from "meteor/meteor";
import { _ } from "meteor/underscore";

import { inMeteor, waitPromise } from "/imports/server/async-helpers";
import { ssrfSafeLookupOrProxy } from "/imports/server/networking";
import { globalDb } from "/imports/db-deprecated";

const Request = HTTPInternals.NpmModules.request.module;

let installers;  // set to {} on main replica
// To protect against race conditions, we require that each row in the Packages
// collection have at most one writer at a time, as tracked by this `installers`
// map. Each key is a package ID and each value is either an AppInstaller object
// or the string 'uninstalling', indicating that some fiber is working on
// uninstalling the package.

const verifyIsMainReplica = () => {
  if (Meteor.settings.replicaNumber) {
    throw new Error("This can only be called on the main front-end replica.");
  }
};

const deletePackageInternal = (pkg) => {
  verifyIsMainReplica();

  const packageId = pkg._id;

  if (packageId in installers) {
    return;
  }

  installers[packageId] = "uninstalling";

  try {
    const action = globalDb.collections.userActions.findOne({ packageId: packageId });
    const grain = globalDb.collections.grains.findOne({ packageId: packageId });
    const notificationQuery = {};
    notificationQuery["appUpdates." + pkg.appId + ".packageId"] = packageId;
    if (!grain && !action && !globalDb.collections.notifications.findOne(notificationQuery)
        && !globalDb.getAppIdForPreinstalledPackage(packageId)) {
      globalDb.collections.packages.update({
        _id: packageId,
      }, {
        $set: { status: "delete" },
        $unset: { shouldCleanup: "" },
      });
      waitPromise(globalBackend.cap().deletePackage(packageId));
      globalDb.collections.packages.remove(packageId);

      // Clean up assets (icon, etc).
      getAllManifestAssets(pkg.manifest).forEach((assetId) => {
        globalDb.unrefStaticAsset(assetId);
      });
    } else {
      globalDb.collections.packages.update({ _id: packageId }, { $unset: { shouldCleanup: "" } });
    }

    delete installers[packageId];
  } catch (error) {
    delete installers[packageId];
    throw error;
  }
};

const startInstallInternal = (pkg) => {
  verifyIsMainReplica();

  if (pkg._id in installers) {
    return;
  }

  const installer = new AppInstaller(pkg._id, pkg.url, pkg.appId, pkg.isAutoUpdated);
  installers[pkg._id] = installer;
  installer.start();
};

export function cancelDownload(packageId) {
  globalDb.collections.packages.remove({ _id: packageId, status: "download" });
}

const cancelDownloadInternal = (pkg) => {
  verifyIsMainReplica();

  const installer = installers[pkg._id];

  // Don't do anything unless a download is in progress.
  if (installer && installer.downloadRequest) {
    // OK, effect cancellation by faking an error.
    installer.wrapCallback(() => {
      throw new Error("Canceled");
    })();
  }
};

if (!Meteor.settings.replicaNumber) {
  installers = {};

  Meteor.startup(() => {
    // Restart any deletions that were killed while in-progress.
    globalDb.collections.packages.find({ status: "delete" }).forEach(deletePackageInternal);

    // Watch for new installation requests and fulfill them.
    globalDb.collections.packages.find({ status: { $in: ["download", "verify", "unpack", "analyze"] } }).observe({
      added: startInstallInternal,
      removed: cancelDownloadInternal,
    });

    // Watch for new cleanup requests and fulfill them.
    globalDb.collections.packages.find({ status: "ready", shouldCleanup: true }).observe({
      added: deletePackageInternal,
    });
  });
}

export function readPackageFromStream(stream, backend, progress = function() {}) {
  // readPackageFromStream reads an spk pacakge from stream and uploads it into
  // backend.
  //
  // The optional progress callback will be invoked each time a chunk is written,
  // which is useful e.g. for updating progress bars. The length of the chunk is
  // passed as an argument.
  //
  // Returns a promise which resolves to an object with fields:
  //
  // info: the return value of PackageUploadStream.saveAs().
  // packageId: The package id of the uploaded package.
  const backendStream = backend.cap().installPackage().stream;
  const hasher = Crypto.createHash("sha256");

  return new Promise((resolve, reject) => {
    pipeline(stream, new Writable({
      write(chunk, _encoding, callback) {
        hasher.update(chunk);
        backendStream.write(chunk).then(() => {
          callback();
          progress(chunk.length);
        }, reject);
      },
    }), (err, _val) => {
      if(err) {
        reject(err);
        return;
      }
      resolve((async () => {
        backendStream.done();
        const packageId = hasher.digest("hex").slice(0, 32);
        let info = await backendStream.saveAs(packageId);
        return {info, packageId};
      })());
    });
  }).finally(() => backendStream.close());
}

class AppInstaller {
  constructor(packageId, url, appId, isAutoUpdated) {
    verifyIsMainReplica();

    this.packageId = packageId;
    this.url = url;
    this.failed = false;
    this.appId = appId;
    this.isAutoUpdated = isAutoUpdated;

    // Serializes database writes.
    this.writeChain = Promise.resolve();
  }

  updateProgress(status, progress, error, manifest) {
    // TODO(security):  On error, we should actually delete the package from the database and only
    //   display the error to whomever was watching at the time.  Otherwise it's easy to confuse
    //   people by 'pre-failing' packages.  (Actually, perhaps if a user tries to download an
    //   already-downloading package but specifies a different URL, we really should initiate an
    //   entirely separate download...  but cancel it if the first download succeeds.)

    this.status = status;
    this.progress = progress || -1;
    this.error = error;
    this.manifest = manifest || null;

    const _this = this;

    // The callback passed to inMeteor() runs in a new fiber. We need to make sure database writes
    // occur in exactly the order in which we generate them, so we use a promise chain to serialize
    // them.
    this.writeChain = this.writeChain.then(() => {
      return inMeteor(() => {
        if (manifest) extractManifestAssets(manifest);

        globalDb.collections.packages.update(_this.packageId, {
          $set: {
            status: _this.status,
            progress: _this.progress,
            error: _this.error ? _this.error.message : null,
            manifest: _this.manifest,
            appId: _this.appId,
            authorPgpKeyFingerprint: _this.authorPgpKeyFingerprint,
          },
        });

        if (_this.authorPgpKeyFingerprint) {
          globalDb.updateKeybaseProfileAsync(_this.authorPgpKeyFingerprint);
        }
      }).catch((err) => {
        console.error(err.stack);
      });
    });
  }

  wrapCallback(method) {
    // Note that the function below must not be an arrow function, since arrow functions do not have
    // access to the context's arguments array.
    const _this = this;
    return function () {
      if (_this.failed) return;
      try {
        return method.apply(_this, _.toArray(arguments));
      } catch (err) {
        _this.fail(err);
      }
    };
  }

  fail(err) {
    if(!this.failed) {
      this.failed = true;
      this.cleanup();
      this.updateProgress("failed", 0, err);
      this.writeChain = this.writeChain.then(() => {
        delete installers[this.packageId];
      });
      console.error("Failed to install app:", err.stack);
    }
  }

  cleanup() {
    if (this.uploadStream) {
      try {
        this.uploadStream.close();
      } catch (err) {}

      delete this.uploadStream;
    }

    if (this.downloadRequest) {
      try {
        this.downloadRequest.abort();
      } catch (err) {}

      delete this.downloadRequest;
    }
  }

  start() {
    return this.wrapCallback(() => {
      this.cleanup();

      globalBackend.cap().tryGetPackage(this.packageId).then(this.wrapCallback((info) => {
        if (info.appId) {
          this.appId = info.appId;
          this.authorPgpKeyFingerprint = info.authorPgpKeyFingerprint;
          this.done(info.manifest);
        } else {
          this.doDownload();
        }
      }), this.wrapCallback((err) => {
        throw err;
      }));
    })();
  }

  doDownload() {
    if (!this.url) {
      throw new Error("Unknown package ID, and no URL was provided.");
    }

    console.log("Downloading app:", this.url);
    this.updateProgress("download");

    inMeteor(this.wrapCallback(function () {
      const safe = ssrfSafeLookupOrProxy(globalDb, this.url);

      let bytesExpected = undefined;
      let bytesReceived = 0;
      let done = false;
      const updateDownloadProgress = _.throttle(this.wrapCallback(() => {
        if (!done) {
          if (bytesExpected) {
            this.updateProgress("download", bytesReceived / bytesExpected);
          } else {
            this.updateProgress("download", bytesReceived);
          }
        }
      }), 500);

      const request = safe.proxy
          ? Request.get(this.url, { proxy: safe.proxy })
          : Request.get(safe.url, {
              headers: { host: safe.host },
              servername: safe.host.split(":")[0],
            });

      request.on("response", this.wrapCallback((response) => {
        if (response.statusCode != 200) {
          throw new Error("Package download returned error: " + response.statusCode);
        }

        if ("content-length" in response.headers) {
          bytesExpected = parseInt(response.headers["content-length"]);
        }
        readPackageFromStream(response, globalBackend, (chunkLen) => {
          bytesReceived += chunkLen;
          updateDownloadProgress();
        }).then(({info}) => {
          done = true;
          delete this.downloadRequest;

          this.appId = info.appId;
          this.authorPgpKeyFingerprint = info.authorPgpKeyFingerprint;
          this.done(info.manifest);
        }, (err) => {
          this.fail(err);
        });
      }))

      this.downloadRequest = request;
    }));
  }

  done(manifest) {
    console.log("App ready:", this.packageId);
    this.updateProgress("ready", 1, undefined, manifest);
    const _this = this;
    _this.writeChain = _this.writeChain.then(() => {
      return inMeteor(() => {
        if (_this.isAutoUpdated) {
          globalDb.sendAppUpdateNotifications(_this.appId, _this.packageId,
            (manifest.appTitle && manifest.appTitle.defaultText), manifest.appVersion,
            (manifest.appMarketingVersion && manifest.appMarketingVersion.defaultText));
        }

        if (globalDb.getPackageIdForPreinstalledApp(_this.appId) &&
            globalDb.collections.appIndex.findOne({
              _id: _this.appId,
              packageId: _this.packageId,
            })) {
          // Only mark app as preinstall ready if its appId is in the preinstalledApps setting
          // and if it's the latest package version in the appIndex. The updateAppIndex function
          // will always trigger updates of preinstalled apps, even if a concurrent download of
          // an older package is going on.
          globalDb.setPreinstallAppAsReady(_this.appId, _this.packageId);
        }

        // Reset any sessions that were blocked by this package ID missing.
        globalDb.collections.sessions.remove({missingPackageId: _this.packageId});
      });
    }).then(() => {
      delete installers[_this.packageId];
    });
  }
}

function extractManifestAssets(manifest) {
  const metadata = manifest.metadata;
  if (!metadata) return;

  const icons = metadata.icons;
  if (icons) {
    const handleIcon = (icon) => {
      if (icon.svg) {
        icon.assetId = globalDb.addStaticAsset({ mimeType: "image/svg+xml" }, icon.svg);
        icon.format = "svg";
        delete icon.svg;
        return true;
      } else if (icon.png) {
        // Use the 1x version for 'normal' DPI, unless 1x isn't provided, in which case use 2x.
        const normalDpi = icon.png.dpi1x || icon.png.dpi2x;
        if (!normalDpi) return false;
        icon.format = "png";
        icon.assetId = globalDb.addStaticAsset({ mimeType: "image/png" }, normalDpi);

        if (icon.png.dpi1x && icon.png.dpi2x) {
          // Icon specifies both resolutions, so also record a 2x DPI option.
          icon.assetId2xDpi = globalDb.addStaticAsset({ mimeType: "image/png" }, icon.png.dpi2x);
        }

        delete icon.png;
        return true;
      } else {
        // Unknown icon. Filter it.
        return false;
      }
    };

    if (icons.appGrid && !handleIcon(icons.appGrid)) delete icons.appGrid;
    if (icons.grain && !handleIcon(icons.grain)) delete icons.grain;

    // We don't need the market icons.
    if (icons.market) delete icons.market;
    if (icons.marketBig) delete icons.marketBig;
  }

  const handleLocalizedText = (text) => {
    if (text.defaultText) {
      text.defaultTextAssetId = globalDb.addStaticAsset({ mimeType: "text/plain" }, text.defaultText);
      delete text.defaultText;
    }

    if (text.localizations) {
      text.localizations.forEach((localization) => {
        if (localization.text) {
          localization.assetId = globalDb.addStaticAsset(
              { mimeType: "text/plain" }, localization.text);
          delete localization.text;
        }
      });
    }
  };

  const license = metadata.license;
  if (license) {
    if (license.proprietary) license.proprietary = handleLocalizedText(license.proprietary);
    if (license.publicDomain) license.publicDomain = handleLocalizedText(license.proprietary);
    if (license.notices) license.notices = handleLocalizedText(license.notices);
  }

  const author = metadata.author;
  if (author) {
    // We remove the PGP signature since it was already verified down to a key ID in the back-end.
    if (author.pgpSignature) delete author.pgpSignature;
  }

  // Don't need the keyring either.
  if (metadata.pgpKeyring) delete metadata.pgpKeyring;

  // Perhaps used by the 'about' page?
  if (metadata.description) metadata.description = handleLocalizedText(metadata.description);

  // Screenshots are for app marketing; we don't use them post-install.
  if (metadata.screenshots) delete metadata.screenshots;

  // We might allow the user to view the changelog.
  if (metadata.changeLog) metadata.changeLog = handleLocalizedText(metadata.changeLog);
}

function getAllManifestAssets(manifest) {
  // Returns a list of all asset IDs in the given manifest.

  const metadata = manifest.metadata;
  if (!metadata) return [];

  const result = [];

  const icons = metadata.icons;
  if (icons) {
    const handleIcon = (icon) => {
      if (icon.assetId) {
        result.push(icon.assetId);
      }
    };

    if (icons.appGrid) handleIcon(icons.appGrid);
    if (icons.grain) handleIcon(icons.grain);
  }

  const handleLocalizedText = (text) => {
    if (text.defaultTextAssetId) {
      result.push(text.defaultTextAssetId);
    }

    if (text.localizations) {
      text.localizations.forEach((localization) => {
        if (localization.assetId) {
          result.push(localization.assetId);
        }
      });
    }
  };

  const license = metadata.license;
  if (license) {
    if (license.proprietary) handleLocalizedText(license.proprietary);
    if (license.publicDomain) handleLocalizedText(license.publicDomain);
    if (license.notices) handleLocalizedText(license.notices);
  }

  if (metadata.description) handleLocalizedText(metadata.description);
  if (metadata.changeLog) handleLocalizedText(metadata.changeLog);

  return result;
}
