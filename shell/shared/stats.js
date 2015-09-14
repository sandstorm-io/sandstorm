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
  computeStats = function (since) {
    // Time how long this computation takes
    var startTime = Date.now();

    // We'll need this for a variety of queries.
    var timeConstraint = {$gt: since};

    // This calculates the number of user accounts that have been used
    // during the requested time period.
    var currentlyActiveUsersCount = Meteor.users.find(
      {expires: {$exists: false}, lastActive: timeConstraint}).count();

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


    var planStats = _.countBy(
      Meteor.users.find({expires: {$exists: false}, payments: {$exists: true}},
                        {fields: {plan: 1}}).fetch(),
      "plan"
    );

    var grainCollection = Grains.rawCollection();
    var grainAggregate = Meteor.wrapAsync(grainCollection.aggregate, grainCollection);
    var appCount = grainAggregate([
      {$match: {lastUsed: timeConstraint}},
      {$group: {_id: "$appId", tempGrainCount: {$sum: 1}, userIds: {$addToSet: "$userId"}}},
      {$unwind: "$userIds"},
      {$group: {_id: "$_id", grains: {$max: "$tempGrainCount"}, owners: {$sum: 1}}},
    ]);
    appCount = _.indexBy(appCount, "_id");
    for (var appId in appCount) {
      var app = appCount[appId];
      delete app["_id"];
      var grains = Grains.find({lastUsed: timeConstraint, appId: appId}, {fields: {_id: 1}}).fetch();
      var grainIds = _.pluck(grains, "_id");
      app.sharedUsers = ApiTokens.find({"owner.user.lastUsed": timeConstraint, "grainId": {$in: grainIds}}).count();
    }

    return {
      activeUsers: currentlyActiveUsersCount,
      demoUsers: deletedDemoUsersCount,
      appDemoUsers: deletedAppDemoUsersCount,
      activeGrains: (activeGrainsCount + deletedGrainsCount),
      plans: planStats,
      computeTime: Date.now() - startTime,
      packages: appCount,
    };
  };

  function recordStats() {
    var now = new Date();

    ActivityStats.insert({
      timestamp: now,
      daily: computeStats(new Date(now.getTime() - DAY_MS)),
      weekly: computeStats(new Date(now.getTime() - 7 * DAY_MS)),
      monthly: computeStats(new Date(now.getTime() - 30 * DAY_MS)),
      forever: computeStats(new Date(0)),
    });
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
  Template.adminStats.events({
    'click #regenerateStatsToken': function () {
      Meteor.call('regenerateStatsToken');
    }
  });
  Template.adminStats.onCreated(function () {
    var state = Iron.controller().state;
    var token = state.get("token");
    this.subscribe("activityStats", token);
    this.subscribe("realTimeStats", token);
    this.subscribe("statsTokens", token);
  });
  Template.adminStats.helpers({
    points: function () {
      return ActivityStats.find({}, {sort: {timestamp: -1}}).map(function (point) {
        return _.extend({
          // Report date of midpoint of sample period.
          day: new Date(point.timestamp.getTime() - 12*60*60*1000).toLocaleDateString()
        }, point);
      });
    },
    current: function () {
      return RealTimeStats.findOne("now");
    },
    today: function () {
      return RealTimeStats.findOne("today");
    },
    token: function () {
      return StatsTokens.findOne();
    }
  });
}
