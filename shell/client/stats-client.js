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

// Pseudo-collection defined via publish.
RealTimeStats = new Mongo.Collection("realTimeStats");

const saveReportStats = function (newValue, template) {
  const state = Iron.controller().state;
  const token = state.get("token");
  template.reportStatsSaved.set(false);
  template.fadeCheckmark.set(false);
  if (template.fadeTimeoutId) {
    Meteor.clearTimeout(template.fadeTimeoutId);
  }

  Meteor.call("setSetting", token, "reportStats", newValue, function (err) {
    if (err) {
      // TODO(someday): do something with error, for now spinner will just show forever
      return;
    }

    template.reportStatsSaved.set(true);
    template.fadeTimeoutId = Meteor.setTimeout(function () {
      template.fadeCheckmark.set(true);
    }, 1000);

    Meteor.call("dismissAdminStatsNotifications", token);
  });
};

Template.adminStats.events({
  "click #regenerateStatsToken": function () {
    Meteor.call("regenerateStatsToken");
  },

  "change select.package-date": function (ev, template) {
    template.currentPackageDate.set(ev.currentTarget.value);
  },

  "change input.enableStatsCollection": function (ev, template) {
    saveReportStats(ev.target.checked, template);
  },

  "click .report-stats-yesno-box>.yes": function (ev, template) {
    saveReportStats(true, template);
  },

  "click .report-stats-yesno-box>.no": function (ev, template) {
    saveReportStats(false, template);
  },
});

Template.adminStats.onCreated(function () {
  const state = Iron.controller().state;
  const token = state.get("token");
  this.currentPackageDate = new ReactiveVar(null);
  this.reportStatsSaved = new ReactiveVar(null);
  this.fadeCheckmark = new ReactiveVar(false);
  this.autorun(() => {
    const stat = ActivityStats.findOne({}, { sort: { timestamp: -1 } });
    if (stat) {
      this.currentPackageDate.set(stat._id);
    }
  });

  this.subscribe("activityStats", token);
  this.subscribe("realTimeStats", token);
  this.subscribe("statsTokens", token);
  this.subscribe("allPackages", token);
});

Template.adminStats.helpers({
  setDocumentTitle: function () {
    document.title = "Stats · Admin · " + globalDb.getServerTitle();
  },

  points: function () {
    return ActivityStats.find({}, { sort: { timestamp: -1 } }).map(function (point) {
      return _.extend({
        // Report date of midpoint of sample period.
        day: new Date(point.timestamp.getTime() - 12 * 60 * 60 * 1000).toLocaleDateString(),
      }, point);
    });
  },

  appDates: function () {
    const template = Template.instance();
    return ActivityStats.find({}, { sort: { timestamp: -1 }, fields: { timestamp: 1 } })
        .map(function (point) {
      return _.extend({
        // Report date of midpoint of sample period.
        day: new Date(point.timestamp.getTime() - 12 * 60 * 60 * 1000).toLocaleDateString(),
        selected: point._id === template.currentPackageDate.get(),
      }, point);
    });
  },

  apps: function () {
    const template = Template.instance();
    const stats = ActivityStats.findOne({ _id: template.currentPackageDate.get() });
    if (!stats) {
      return;
    }

    const apps = {};
    const pivotApps = function (time) {
      let data = stats[time];
      if (!data) {
        return;
      }

      data = data.apps;
      for (const appId in data) {
        const p = data[appId];
        apps[appId] = apps[appId] || {};
        apps[appId][time] = p;
      }
    };

    pivotApps("daily");
    pivotApps("weekly");
    pivotApps("monthly");
    pivotApps("forever");
    return _.chain(apps)
      .map(function (packObj, appId) {
        packObj.appId = appId;
        // Find the newest version of this app.
        const p = Packages.findOne({
          appId: appId,
          manifest: { $exists: true },
        }, {
          sort: { "manifest.appVersion": -1 },
        });
        if (p) {
          packObj.appTitle = SandstormDb.appNameFromPackage(p);
        }

        return packObj;
      })
      .sortBy(function (app) { return -((app.daily || {}).owners || 0); })
      .value();
  },

  current: function () {
    return RealTimeStats.findOne("now");
  },

  today: function () {
    return RealTimeStats.findOne("today");
  },

  token: function () {
    return StatsTokens.findOne();
  },

  reportStats: function () {
    const setting = Settings.findOne({ _id: "reportStats" });
    return setting && setting.value === true;
  },

  reportStatsFirstVisit: function () {
    const setting = Settings.findOne({ _id: "reportStats" });
    return !setting || setting.value === "unset";
  },

  reportStatsSaving: function () {
    return !Match.test(Template.instance().reportStatsSaved.get(), Match.OneOf(undefined, null));
  },

  reportStatsSaved: function () {
    return Template.instance().reportStatsSaved.get();
  },

  fadeCheckmark: function () {
    return Template.instance().fadeCheckmark.get();
  },
});
