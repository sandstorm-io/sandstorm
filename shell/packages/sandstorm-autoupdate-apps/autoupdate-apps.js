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

SandstormAutoupdateApps.getAppIndex = function (db) {
  var appUpdatesEnabled = Settings.findOne({_id: "appUpdatesEnabled"}).value;
  if (!appUpdatesEnabled) {
    // It's much simpler to check appUpdatesEnabled here rather than reactively deactivate the
    // timer that triggers this call.
    return;
  }
  var appIndexUrl = Settings.findOne({_id: "appIndexUrl"}).value;
  var appIndex = db.collections.appIndex;
  var data = HTTP.get(appIndexUrl + "/apps/index.json").data;
  data.apps.forEach(function (app) {
    app._id = app.appId;

    var oldApp = appIndex.findOne({_id: app.appId});
    app.hasSentNotifications = false;
    appIndex.upsert({_id: app._id}, app);
    if ((!oldApp || app.versionNumber > oldApp.versionNumber) &&
        UserActions.findOne({appId: app.appId})) {
      var pack = Packages.findOne({_id: app.packageId});
      var url = appIndexUrl + "/packages/" + app.packageId;
      if (pack) {
        if (pack.status === "ready") {
          db.sendAppUpdateNotifications(app.appId, app.packageId, app.name, app.versionNumber, app.version);
        } else {
          var newPack = Packages.findAndModify({
            query: {_id: app.packageId},
            update: {$set: {isAutoUpdated: true}},
          });
          if (newPack.status === "ready") {
            // The package was marked as ready before we applied isAutoUpdated=true. We should send
            // notifications ourselves to be sure there's no timing issue (sending more than one is
            // fine, since it will de-dupe).
            db.sendAppUpdateNotifications(app.appId, app.packageId, app.name, app.versionNumber, app.version);
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
  updateApps: function(appUpdates) {
    var db = this.connection.sandstormDb;

    _.forEach(appUpdates, function (val, appId) {
      var pack = db.collections.packages.findOne({_id: val.packageId});
      if (!pack || !pack.manifest) {
        console.error("Newer app not installed", val.name);
      } else {
        db.addUserActions(val.packageId);
        db.upgradeGrains(appId, val.version, val.packageId);
        Meteor.call("deleteUnusedPackages", appId);
      }
    });
  },
});
