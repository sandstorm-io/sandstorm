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

var DAY_MS = 24*60*60*1000;

if (Meteor.isServer) {
  if (Mongo.Collection.prototype.aggregate) {
    throw new Error("Looks like Meteor wrapped the Collection.aggregate() call. Make sure it " +
                    "works then delete our own wrapper.");
  }
  Mongo.Collection.prototype.aggregate = function () {
    // Meteor doesn't wrapp Mongo's aggregate() method.
    var raw = this.rawCollection();
    return Meteor.wrapAsync(raw.aggregate, raw).apply(raw, arguments);
  };

  computeStats = function (since) {
    // We'll need this for a variety of queries.
    var timeConstraint = {$gt: since};

    // This calculates the number of user accounts that have been used
    // during the requested time period.
    var currentlyActiveUsersCount = Meteor.users.find(
      {expires: {$exists: false}, loginIdentities: {$exists: true},
       lastActive: timeConstraint}).count();

    // This calculates the number of grains that have been used during
    // the requested time period.
    var activeGrainsCount = Grains.find({lastUsed: timeConstraint}).count();

    // If Meteor.settings.allowDemoAccounts is true, DeleteStats
    // contains records of type `user` and `appDemoUser`, indicating
    // the number of those types of accounts that were created and
    // then auto-expired through the demo mode's auto-account-expiry.
    var deletedDemoUsersCount =  DeleteStats.find(
      {type: "demoUser", lastActive: timeConstraint}).count();
    var deletedAppDemoUsersCount = DeleteStats.find(
      {type: "appDemoUser", lastActive: timeConstraint}).count();

    // Similarly, if the demo is enabled, we auto-delete grains; we store that
    // fact in DeleteStats with type: "grain".
    var deletedGrainsCount = DeleteStats.find(
      {type: "grain", lastActive: timeConstraint}).count();

    var apps = Grains.aggregate([
      {$match: {lastUsed: timeConstraint}},
      {$group: {_id: "$appId", grains: {$sum: 1}, userIds: {$addToSet: "$userId"}}},
      {$project: {grains: 1, owners: {$size: "$userIds"}}}
    ]);
    apps = _.indexBy(apps, "_id");

    for (var appId in apps) {
      // We need to count ApiTokens, which don't have appId denormalized into them. We therefore
      // have to fetch a list of grainIds first.
      // TODO(perf): If stats are getting slow, denormalize appId into ApiTokens. Note that it is
      //   already denormalized for the specific case of apps that don't have icons, but the data
      //   for that use case is NOT safe to use here because it's intended that we might allow an
      //   app to mimic another app's icon by spoofing that app ID. In other words, the existing
      //   denormalization of appId should be considered "app ID for identicon purposes only". We'll
      //   need to add a new denormalization for stats purposes -- and make sure that it is not
      //   revealed to the user.
      var app = apps[appId];
      delete app["_id"];
      var grains = Grains.find({lastUsed: timeConstraint, appId: appId}, {fields: {_id: 1}}).fetch();
      var grainIds = _.pluck(grains, "_id");

      var counts = ApiTokens.aggregate([
        {$match: {"owner.user.lastUsed": timeConstraint, "grainId": {$in: grainIds}}},
        {$group: {_id: "$owner.user.identityId"}},
        {$group: {_id: "count", count: {$sum: 1}}}
      ]);

      if (counts.length > 0) {
        if (counts.length !== 1) {
          console.error("error: sharedUsers aggregation returned multiple rows");
        }
        app.sharedUsers = counts[0].count;
      }
    }

    // Count per-app appdemo users and deleted grains.
    DeleteStats.aggregate([
      {$match: {lastActive: timeConstraint, appId: {$exists: true}}},
      {$group: {_id: {appId: "$appId", type: "$type"}, count: {$sum: 1}}}
    ]).forEach(function (deletion) {
      var app = apps[deletion._id.appId];
      if (!app) {
        app = apps[deletion.appId] = {};
      }
      if (deletion._id.type === "appDemoUser") {
        app.appDemoUsers = deletion.count;
      } else if (deletion._id.type === "grain") {
        app.deleted = deletion.count;
      } else if (deletion._id.type === "demoGrain") {
        app.demoed = deletion.count;
      }
    });

    return {
      activeUsers: currentlyActiveUsersCount,
      demoUsers: deletedDemoUsersCount,
      appDemoUsers: deletedAppDemoUsersCount,
      activeGrains: (activeGrainsCount + deletedGrainsCount),
      apps: apps,
    };
  };

  function recordStats() {
    var now = new Date();

    var planStats = _.countBy(
      Meteor.users.find({expires: {$exists: false}, "payments.id": {$exists: true}},
                        {fields: {plan: 1}}).fetch(),
      "plan"
    );

    var record = {
      timestamp: now,
      daily: computeStats(new Date(now.getTime() - DAY_MS)),
      weekly: computeStats(new Date(now.getTime() - 7 * DAY_MS)),
      monthly: computeStats(new Date(now.getTime() - 30 * DAY_MS)),
      forever: computeStats(new Date(0)),
      plans: planStats
    };
    record.computeTime = Date.now() - now;

    ActivityStats.insert(record);
    var age = ActivityStats.find().count();
    if (age > 3) {
      var reportSetting = Settings.findOne({_id: "reportStats"});
      if (!reportSetting) {
        // Setting not set yet, send out notifications and set it to false
        globalDb.sendAdminNotification("You can help Sandstorm by sending us some anonymous " +
          "usage stats. Click here for more info.", "/admin/stats");
        Settings.insert({_id: "reportStats", value: "unset"});
      } else if (reportSetting.value === true) {
        // The stats page which the user agreed we can send actually displays the whole history
        // of the server, but we're only sending stats from the last day. Let's also throw in the
        // length of said history. This is still strictly less information than what the user said
        // we're allowed to send.
        record.serverAge = age;

        HTTP.post("https://alpha-api.sandstorm.io/data", {
          data: record,
          headers: {
            Authorization: "Bearer aT-mGyNwsgwZBbZvd5FWr0Ma79O9IehI4NiEO94y_oR",
            "Content-Type": "application/json",
          },
        });
      }
    }
  }

  if (!Meteor.settings.replicaNumber) {
    // Wait until 10:00 UTC (2:00 PST / 5:00 EST), then start recording stats every 24 hours.
    // (Only on the first replica to avoid conflicts.)
    Meteor.setTimeout(function () {
      Meteor.setInterval(function () {
        recordStats();
      }, DAY_MS);

      recordStats();
    }, DAY_MS - (Date.now() - 10*60*60*1000) % DAY_MS);

    Meteor.startup(function () {
      if (StatsTokens.find().count() === 0) {
        StatsTokens.remove({});
        StatsTokens.insert({_id: Random.id(22)});
      }
    });
  }

  Meteor.methods({
    regenerateStatsToken: function () {
      if (!isAdmin()) {
        throw new Meteor.Error(403, "Unauthorized", "User must be admin");
      }

      StatsTokens.remove({});
      var token = StatsTokens.insert({_id: Random.id(22)});
      return token._id;
    }
  });
}

// Pseudo-collection defined via publish, above.
RealTimeStats = new Mongo.Collection("realTimeStats");

Router.map(function () {
  this.route("fetchStats", {
    where: "server",
    path: "/fetchStats/:tokenId",
    action: function () {
      var token = StatsTokens.findOne({_id: this.params.tokenId});

      if (!token) {
        this.response.writeHead(404, {
          "Content-Type": "text/plain"
        });
        this.response.write("Token not found");
        return this.response.end();
      }

      try {
        var stats = ActivityStats.find().fetch();
        var statsString = JSON.stringify(stats);

        this.response.writeHead(200, {
          "Content-Type": "application/json"
        });
        this.response.write(statsString);
      } catch(error) {
        console.error(error.stack);
        this.response.writeHead(500, {
          "Content-Type": "text/plain"
        });
        this.response.write(error.stack);
      }
      return this.response.end();
    }
  });
});

if (Meteor.isClient) {
  var saveReportStats = function (newValue, template) {
    var state = Iron.controller().state;
    var token = state.get("token");
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
    'click #regenerateStatsToken': function () {
      Meteor.call('regenerateStatsToken');
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
    var state = Iron.controller().state;
    var token = state.get("token");
    this.currentPackageDate = new ReactiveVar(null);
    this.reportStatsSaved = new ReactiveVar(null);
    this.fadeCheckmark = new ReactiveVar(false);
    var self = this;
    this.autorun(function () {
      var stat = ActivityStats.findOne({}, {sort: {timestamp: -1}});
      if (stat) {
        self.currentPackageDate.set(stat._id);
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
      return ActivityStats.find({}, {sort: {timestamp: -1}}).map(function (point) {
        return _.extend({
          // Report date of midpoint of sample period.
          day: new Date(point.timestamp.getTime() - 12*60*60*1000).toLocaleDateString()
        }, point);
      });
    },
    appDates: function () {
      var template = Template.instance();
      return ActivityStats.find({}, {sort: {timestamp: -1}, fields: {timestamp: 1}})
          .map(function (point) {
        return _.extend({
          // Report date of midpoint of sample period.
          day: new Date(point.timestamp.getTime() - 12*60*60*1000).toLocaleDateString(),
          selected: point._id === template.currentPackageDate.get()
        }, point);
      });
    },
    apps: function () {
      var template = Template.instance();
      var stats = ActivityStats.findOne({_id: template.currentPackageDate.get()});
      if (!stats) {
        return;
      }

      var apps = {};
      var pivotApps = function (time) {
        var data = stats[time];
        if (!data) {
          return;
        }
        data = data.apps;
        for (var appId in data) {
          var p = data[appId];
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
          var p = Packages.findOne({appId: appId, manifest: {$exists: true}},
                                   {sort: {"manifest.appVersion": -1}});
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
      var setting = Settings.findOne({_id: "reportStats"});
      return setting && setting.value === true;
    },
    reportStatsFirstVisit: function () {
      var setting = Settings.findOne({_id: "reportStats"});
      return !setting || setting.value === "unset";
    },
    reportStatsSaving: function() {
      return !Match.test(Template.instance().reportStatsSaved.get(), Match.OneOf(undefined, null));
    },
    reportStatsSaved: function() {
      return Template.instance().reportStatsSaved.get();
    },
    fadeCheckmark: function() {
      return Template.instance().fadeCheckmark.get();
    }
  });
}
