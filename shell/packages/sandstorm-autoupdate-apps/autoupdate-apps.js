// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

SandstormAutoupdateApps = {};

SandstormAutoupdateApps.updateAppIndex = function (db) {
  const appUpdatesEnabledSetting = db.collections.settings.findOne({ _id: "appUpdatesEnabled" });
  const appUpdatesEnabled = appUpdatesEnabledSetting && appUpdatesEnabledSetting.value;
  if (!appUpdatesEnabled) {
    // It's much simpler to check appUpdatesEnabled here rather than reactively deactivate the
    // timer that triggers this call.
    return;
  }

  const appIndexUrl = db.collections.settings.findOne({ _id: "appIndexUrl" }).value;
  const appIndex = db.collections.appIndex;
  const data = HTTP.get(appIndexUrl + "/apps/index.json").data;
  data.apps.forEach(function (app) {
    app._id = app.appId;

    const oldApp = appIndex.findOne({ _id: app.appId });
    app.hasSentNotifications = false;
    appIndex.upsert({ _id: app._id }, app);
    if ((!oldApp || app.versionNumber > oldApp.versionNumber) &&
        db.collections.userActions.findOne({ appId: app.appId })) {
      const pack = db.collections.packages.findOne({ _id: app.packageId });
      const url = appIndexUrl + "/packages/" + app.packageId;
      if (pack) {
        if (pack.status === "ready") {
          if (pack.appId && pack.appId !== app.appId) {
            console.error("app index returned app ID and package ID that don't match:",
                          JSON.stringify(app));
          } else {
            db.sendAppUpdateNotifications(app.appId, app.packageId, app.name, app.versionNumber,
              app.version);
          }
        } else {
          const newPack = Packages.findAndModify({
            query: { _id: app.packageId },
            update: { $set: { isAutoUpdated: true } },
          });
          if (newPack.status === "ready") {
            // The package was marked as ready before we applied isAutoUpdated=true. We should send
            // notifications ourselves to be sure there's no timing issue (sending more than one is
            // fine, since it will de-dupe).
            if (pack.appId && pack.appId !== app.appId) {
              console.error("app index returned app ID and package ID that don't match:",
                            JSON.stringify(app));
            } else {
              db.sendAppUpdateNotifications(app.appId, app.packageId, app.name, app.versionNumber,
                app.version);
            }
          } else if (newPack.status === "failed") {
            // If the package has failed, retry it
            db.startInstall(app.packageId, url, true, true);
          }
        }
      } else {
        db.startInstall(app.packageId, url, false, true);
      }
    }
  });
};

Meteor.methods({
  updateApps: function (appUpdates) {
    const db = this.connection.sandstormDb;
    const backend = this.connection.sandstormBackend;

    _.forEach(appUpdates, function (val, appId) {
      const pack = db.collections.packages.findOne({ _id: val.packageId, appId: appId });
      if (!pack || !pack.manifest) {
        console.error("Newer app not installed", val.name);
      } else {
        db.addUserActions(val.packageId);
        db.upgradeGrains(appId, val.version, val.packageId, backend);
        db.deleteUnusedPackages(appId);
      }
    });
  },
});
