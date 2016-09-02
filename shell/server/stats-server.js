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

import { allowDemo } from "/imports/demo.js";

const DAY_MS = 24 * 60 * 60 * 1000;

if (Mongo.Collection.prototype.aggregate) {
  throw new Error("Looks like Meteor wrapped the Collection.aggregate() call. Make sure it " +
                  "works then delete our own wrapper.");
}

Mongo.Collection.prototype.aggregate = function () {
  // Meteor doesn't wrapp Mongo's aggregate() method.
  const raw = this.rawCollection();
  return Meteor.wrapAsync(raw.aggregate, raw).apply(raw, arguments);
};

computeStats = function (since) {
  // We'll need this for a variety of queries.
  const timeConstraint = { $gt: since };

  // This calculates the number of user accounts that have been used
  // during the requested time period.
  const currentlyActiveUsersCount = Meteor.users.find({
    expires: { $exists: false },
    loginIdentities: { $exists: true },
    lastActive: timeConstraint,
  }).count();

  // This calculates the number of grains that have been used during
  // the requested time period.
  const activeGrainsCount = Grains.find({ lastUsed: timeConstraint }).count();

  // If Meteor.settings.allowDemoAccounts is true, DeleteStats
  // contains records of type `user` and `appDemoUser`, indicating
  // the number of those types of accounts that were created and
  // then auto-expired through the demo mode's auto-account-expiry.
  const deletedDemoUsersCount =  DeleteStats.find(
    { type: "demoUser", lastActive: timeConstraint }).count();
  const deletedAppDemoUsersCount = DeleteStats.find(
    { type: "appDemoUser", lastActive: timeConstraint }).count();

  // Similarly, if the demo is enabled, we auto-delete grains; we store that
  // fact in DeleteStats with type: "grain".
  const deletedGrainsCount = DeleteStats.find(
    { type: "grain", lastActive: timeConstraint }).count();

  let apps = Grains.aggregate([
    { $match: { lastUsed: timeConstraint } },
    {
      $group: {
        _id: "$appId",
        grains: { $sum: 1 },
        userIds: { $addToSet: "$userId" },
      },
    },
    {
      $project: {
        grains: 1,
        owners: { $size: "$userIds" },
      },
    },
  ]);
  apps = _.indexBy(apps, "_id");

  for (const appId in apps) {
    // We need to count ApiTokens, which don't have appId denormalized into them. We therefore
    // have to fetch a list of grainIds first.
    // TODO(perf): If stats are getting slow, denormalize appId into ApiTokens. Note that it is
    //   already denormalized for the specific case of apps that don't have icons, but the data
    //   for that use case is NOT safe to use here because it's intended that we might allow an
    //   app to mimic another app's icon by spoofing that app ID. In other words, the existing
    //   denormalization of appId should be considered "app ID for identicon purposes only". We'll
    //   need to add a new denormalization for stats purposes -- and make sure that it is not
    //   revealed to the user.
    const app = apps[appId];
    delete app._id;
    const grains = Grains.find({
      lastUsed: timeConstraint,
      appId: appId,
    }, {
      fields: { _id: 1 },
    }).fetch();
    const grainIds = _.pluck(grains, "_id");

    const counts = ApiTokens.aggregate([
      {
        $match: {
          "owner.user": { $exists: true },
          lastUsed: timeConstraint,
          grainId: { $in: grainIds },
        },
      },
      { $group: { _id: "$owner.user.identityId" } },
      {
        $group: {
          _id: "count",
          count: { $sum: 1 },
        },
      },
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
    {
      $match: {
        lastActive: timeConstraint,
        appId: { $exists: true },
      },
    },
    {
      $group: {
        _id: {
          appId: "$appId",
          type: "$type",
        },
        count: { $sum: 1 },
      },
    },
  ]).forEach(function (deletion) {
    let app = apps[deletion._id.appId];
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
  const postStats = function (record) {
    HTTP.post("https://alpha-api.sandstorm.io/data", {
      data: record,
      headers: {
        Authorization: "Bearer aT-mGyNwsgwZBbZvd5FWr0Ma79O9IehI4NiEO94y_oR",
        "Content-Type": "application/json",
      },
    });
  };

  const now = new Date();

  const planStats = _.countBy(
    Meteor.users.find({ expires: { $exists: false }, "payments.id": { $exists: true } },
                      { fields: { plan: 1 } }).fetch(),
    "plan"
  );

  const record = {
    timestamp: now,
    daily: computeStats(new Date(now.getTime() - DAY_MS)),
    weekly: computeStats(new Date(now.getTime() - 7 * DAY_MS)),
    monthly: computeStats(new Date(now.getTime() - 30 * DAY_MS)),
    forever: computeStats(new Date(0)),
    plans: planStats,
  };
  record.computeTime = Date.now() - now;
  if (global.BlackrockPayments && global.BlackrockPayments.getTotalCharges) {
    // This only exists under Blackrock
    record.totalCharges = global.BlackrockPayments.getTotalCharges();
  }

  ActivityStats.insert(record);
  const age = ActivityStats.find().count();
  // The stats page which the user agreed we can send actually displays the whole history
  // of the server, but we're only sending stats from the last day. Let's also throw in the
  // length of said history. This is still strictly less information than what the user said
  // we're allowed to send.
  record.serverAge = age;

  if (globalDb.isFeatureKeyOptedIntoStats()) {
    record.customerId = globalDb.currentFeatureKey().customer.id;
    postStats(record);
  } else if (age > 3) {
    const reportSetting = Settings.findOne({ _id: "reportStats" });

    if (!reportSetting) {
      // Setting not set yet, send out notifications and set it to false
      globalDb.sendAdminNotification("You can help Sandstorm by sending us some anonymous " +
        "usage stats. Click here for more info.", "/admin/stats");
      Settings.insert({ _id: "reportStats", value: "unset" });
    } else if (reportSetting.value === true) {
      postStats(record);
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
  }, DAY_MS - (Date.now() - 10 * 60 * 60 * 1000) % DAY_MS);

  Meteor.startup(function () {
    if (StatsTokens.find().count() === 0) {
      StatsTokens.remove({});
      StatsTokens.insert({ _id: Random.id(22) });
    }
  });
}

Meteor.methods({
  regenerateStatsToken: function () {
    if (!isAdmin()) {
      throw new Meteor.Error(403, "Unauthorized", "User must be admin");
    }

    StatsTokens.remove({});
    const token = StatsTokens.insert({ _id: Random.id(22) });
    return token._id;
  },
});

Router.map(function () {
  this.route("fetchStats", {
    where: "server",
    path: "/fetchStats/:tokenId",
    action: function () {
      const token = StatsTokens.findOne({ _id: this.params.tokenId });

      if (!token) {
        this.response.writeHead(404, {
          "Content-Type": "text/plain",
        });
        this.response.write("Token not found");
        return this.response.end();
      }

      try {
        const stats = ActivityStats.find().fetch();
        const statsString = JSON.stringify(stats);

        this.response.writeHead(200, {
          "Content-Type": "application/json",
        });
        this.response.write(statsString);
      } catch (error) {
        console.error(error.stack);
        this.response.writeHead(500, {
          "Content-Type": "text/plain",
        });
        this.response.write(error.stack);
      }

      return this.response.end();
    },
  });
});
