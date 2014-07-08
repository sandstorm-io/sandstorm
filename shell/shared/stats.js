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
  function computeStats(since) {
    return {
      activeUsers: Meteor.users.find({lastActive: {$gt: since}}).count() +
          DeleteStats.find({type: "user", lastActive: {$gt: since}}).count(),
      activeGrains: Grains.find({lastUsed: {$gt: since}}).count() +
          DeleteStats.find({type: "grain", lastActive: {$gt: since}}).count()
    }
  }

  function recordStats() {
    var now = new Date();

    ActivityStats.insert({
      timestamp: now,
      daily: computeStats(new Date(now.getTime() - DAY_MS)),
      weekly: computeStats(new Date(now.getTime() - 7 * DAY_MS)),
      monthly: computeStats(new Date(now.getTime() - 30 * DAY_MS))
    });
  }

  // Wait until 10:00 UTC (2:00 PST / 5:00 EST), then start recording stats every 24 hours.
  Meteor.setTimeout(function () {
    Meteor.setInterval(function () {
      recordStats();
    }, DAY_MS);

    recordStats();
  }, DAY_MS - (Date.now() - 10*60*60*1000) % DAY_MS);

  Meteor.publish("activityStats", function () {
    var user = this.userId && Meteor.users.findOne({_id: this.userId}, {fields: {isAdmin: 1}});
    if (!(user && user.isAdmin)) {
      return [];
    }

    return ActivityStats.find();
  });

  Meteor.publish("realTimeStats", function () {
    var user = this.userId && Meteor.users.findOne({_id: this.userId}, {fields: {isAdmin: 1}});
    if (!(user && user.isAdmin)) {
      return [];
    }

    // Last five minutes.
    this.added("realTimeStats", "now", computeStats(new Date(Date.now() - 5*60*1000)));

    // Since last sample.
    var lastSample = ActivityStats.findOne({}, {sort: {timestamp: -1}});
    var lastSampleTime = lastSample ? lastSample.timestamp : new Date(0);
    this.added("realTimeStats", "today", computeStats(lastSampleTime));

    // TODO(someday): Update every few minutes?

    this.ready();
  });
}

// Pseudo-collection defined via publish, above.
RealTimeStats = new Meteor.Collection("realTimeStats");

Router.map(function () {
  this.route("stats", {
    path: "/stats",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
      return [
        Meteor.subscribe("activityStats"),
        Meteor.subscribe("realTimeStats")
      ];
    },

    data: function () {
      return {
        points: ActivityStats.find({}, {sort: {timestamp: -1}}).map(function (point) {
          return _.extend({
            // Report date of midpoint of sample period.
            day: new Date(point.timestamp.getTime() - 12*60*60*1000).toLocaleDateString()
          }, point);
        }),
        current: RealTimeStats.findOne("now"),
        today: RealTimeStats.findOne("today")
      };
    }
  });
});
