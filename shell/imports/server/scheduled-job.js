// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2017 Sandstorm Development Group, Inc. and contributors
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

import { Meteor } from "meteor/meteor";

import { fetchApiToken } from "/imports/server/persistent";
import Capnp from "/imports/server/capnp";
import { SandstormDb } from "/imports/sandstorm-db/db";
import { globalDb } from "/imports/db-deprecated";

const ScheduledJob = Capnp.importSystem("sandstorm/grain.capnp").ScheduledJob;
const SystemPersistent = Capnp.importSystem("sandstorm/supervisor.capnp").SystemPersistent;

const MINIMUM_SCHEDULING_SLACK_NANO = Capnp.importSystem("sandstorm/grain.capnp").minimumSchedulingSlack;
const MINIMUM_SCHEDULING_SLACK_MILLIS = MINIMUM_SCHEDULING_SLACK_NANO / 1e6;

export const scheduleOneShot = (db, grainId, name, callback, when, slack) => {
  callback.castAs(SystemPersistent).save({ frontend: null }).then((result) => {
    db.addOneShotScheduledJob(
      grainId,
      name,
      result.sturdyRef.toString("utf8"),
      when,
      slack,
    ).catch((err) => {
      console.error("Failed adding one-shot scheduled job:", err);
    });
  })
}

export const schedulePeriodic = (db, grainId, name, callback, period) => {
  callback.castAs(SystemPersistent).save({ frontend: null }).then((result) => {
    db.addPeriodicScheduledJob(
      grainId,
      name,
      result.sturdyRef.toString("utf8"),
      period
    ).catch((err) => {
      console.error("Failed adding periodic scheduled job:", err);
    });
  });
}

const KEEP_ALIVE_INTERVAL_MILLIS = 60 * 1000;
const MAX_DISCONNECTED_RETRIES = 5;

export const runDueJobs = async (nowMillis) => {
  const db = globalDb;
  const staleKeepAlive = new Date(nowMillis - 3 * KEEP_ALIVE_INTERVAL_MILLIS);
  const jobs = await db.getReadyScheduledJobs(nowMillis, staleKeepAlive);

  const promises = [];

  for (const job of jobs) {
    if (job.lastKeepAlive) {
      if (job.retries && job.retries >= MAX_DISCONNECTED_RETRIES) {
        await db.recordScheduledJobRan(job, {
          finished: job.lastKeepAlive,
          type: "disconnected",
          message: "MAX_DISCONNECTED_RETRIES exceeded",
        });
      } else {
        await db.scheduledJobIncrementRetries(job._id);
      }
    }

    const token = await fetchApiToken(db, job.callback);
    if (!token) {
      throw new Error("could not find ApiToken for callback", job.callback);
    }

    let intervalHandle;

    promises.push(Promise.resolve().then(async () => {
      let callback = (await globalThis.restoreInternal(db, job.callback, { frontend: null }, [], token)).cap;
      callback = callback.castAs(ScheduledJob.Callback);

      intervalHandle = Meteor.setInterval(() => {
        globalThis.globalBackend.useGrain(job.grainId, (supervisor) => {
          return supervisor.keepAlive();
        });
        db.updateScheduledJobKeepAlive(job._id).catch((err) => {
          console.error("Failed updating scheduled-job keepAlive:", err);
        });
      }, KEEP_ALIVE_INTERVAL_MILLIS);

      return callback.run();
    }).then(async ({cancelFutureRuns}) => {
      if(cancelFutureRuns || job.period === undefined) {
        // Either the job explicitly told us to cancel it (cancelFutureRuns),
        // or it was one-shot job (period is undefined). Remove the job:
        await db.deleteScheduledJob(job._id);
        return;
      }
      await db.recordScheduledJobRan(job);
    }, (e) => {
      if (e.kjType === "disconnected") {
        return db.scheduledJobIncrementRetries(job._id);
      } else {
        const type = e.kjType || "failed";
        return db.recordScheduledJobRan(job, {
          finished: new Date(),
          type,
          message: e.toString().slice(0, 200), // cap length to prevent grain from spamming the db
        });
      }
    }).catch((e) => {
      console.error("error while scheduling job", e);
    }).then(() => {
      if (intervalHandle) {
        Meteor.clearInterval(intervalHandle);
      }
    }));
  }

  await Promise.all(promises);
}

SandstormDb.periodicCleanup(MINIMUM_SCHEDULING_SLACK_MILLIS, () => {
  runDueJobs(Date.now()).catch((err) => {
    console.error("Error while running scheduled jobs:", err);
  });
});

Meteor.publish("scheduledJobs", async function() {
  // Returns info about all jobs for grains owned by the current user.
  if(!this.userId) {
    return [];
  }
  const db = globalDb;
  const sub = this;
  const publishedIds = new Set();
  const cursor = db.collections.scheduledJobs.find({}, {
    _id: 1,
    grainId: 1,
    name: 1,
    created: 1,
    period: 1,
    nextPeriodStart: 1,
    previousError: 1,
  });

  const shouldPublish = async (job) => {
    if (await db.isAdminById(sub.userId)) return true;
    const grain = await db.collections.grains.findOneAsync({ _id: job.grainId }, { fields: { userId: 1 } });
    return !!grain && grain.userId === sub.userId;
  };

  const publishInitialAndReady = async () => {
    const initialJobs = await cursor.fetchAsync();
    for (const job of initialJobs) {
      if (await shouldPublish(job)) {
        sub.added("scheduledJobs", job._id, job);
        publishedIds.add(job._id);
      }
    }

    sub.ready();
  };

  publishInitialAndReady().catch((err) => {
    console.error("Failed initializing scheduledJobs publication:", err);
  });

  const handle = await cursor.observeAsync({
    added(job) {
      if (publishedIds.has(job._id)) return;
      shouldPublish(job).then((ok) => {
        if (ok && !publishedIds.has(job._id)) {
          sub.added("scheduledJobs", job._id, job);
          publishedIds.add(job._id);
        }
      }).catch((err) => {
        console.error("scheduledJobs added handler failed:", err);
      });
    },

    changed(newJob) {
      shouldPublish(newJob).then((ok) => {
        const isPublished = publishedIds.has(newJob._id);
        if (ok) {
          if (isPublished) {
            sub.changed("scheduledJobs", newJob._id, newJob);
          } else {
            sub.added("scheduledJobs", newJob._id, newJob);
            publishedIds.add(newJob._id);
          }
        } else if (isPublished) {
          sub.removed("scheduledJobs", newJob._id);
          publishedIds.delete(newJob._id);
        }
      }).catch((err) => {
        console.error("scheduledJobs changed handler failed:", err);
      });
    },

    removed(job) {
      if (publishedIds.has(job._id)) {
        sub.removed("scheduledJobs", job._id);
        publishedIds.delete(job._id);
      }
    },
  });

  this.onStop(() => {
    Promise.resolve(handle).then((h) => {
      if (typeof h === "function") { h(); } else if (h && typeof h.stop === "function") h.stop();
    }).catch((err) => {
      console.error("Failed stopping scheduledJobs observer:", err);
    });
  });
});
