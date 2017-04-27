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

const Capnp = Npm.require("capnp");
import { inMeteor, waitPromise } from "/imports/server/async-helpers.js";
const Runnable = Capnp.importSystem("sandstorm/util.capnp").Runnable;
const ScheduledJobRpc = Capnp.importSystem("sandstorm/scheduled-job-impl.capnp");
const ScheduledJob = Capnp.importSystem("sandstorm/grain.capnp").ScheduledJob;
const SystemPersistent = Capnp.importSystem("sandstorm/supervisor.capnp").SystemPersistent;
import { PersistentImpl, fetchApiToken } from "/imports/server/persistent.js";

class ScheduledJobImpl extends PersistentImpl {
  constructor(db, saveTemplate, scheduledJobId) {
    super(db, saveTemplate);
    this.scheduledJobId = scheduledJobId;
    this.db = db;
  }

  confirm() {
    return inMeteor(() => {
      this.db.confirmScheduledJob(this.scheduledJobId);
    });
  }

  cancel() {
    return inMeteor(() => {
      this.db.deleteScheduledJob(this.scheduledJobId);
    });
  }
};

makeScheduledJob = (db, grainId, period, callback) => {
  const promise = callback.castAs(SystemPersistent).save({ frontend: null }).then((result) => {
    const jobId = db.addScheduledJob(grainId, result.sturdyRef.toString("utf8"), period);
    const saveTemplate = { frontendRef: { scheduledJob: { id: jobId } } };
    return new Capnp.Capability(
      new ScheduledJobImpl(db, saveTemplate, jobId),
      ScheduledJobRpc.PersistentScheduledJob);
  });

  return new Capnp.Capability(
    promise,
    ScheduledJobRpc.PersistentScheduledJob);
};

globalFrontendRefRegistry.register({
  frontendRefField: "scheduledJob",
  typeId: ScheduledJob.typeId,

  restore(db, saveTemplate, value) {
    return new Capnp.Capability(
      new ScheduledJobImpl(db, saveTemplate, value.id),
      ScheduledJobRpc.PersistentScheduledJob);
  },

  validate(db, session, value) {
    throw new Error("not allowed to make a powerbox request for a ScheduledJob");
  },

  query(db, userId, value) {
    return [];
  },
});

const KEEP_ALIVE_INTERVAL_MILLIS = 60 * 1000;
const MAX_DISCONNECTED_RETRIES = 5;

SandstormDb.periodicCleanup(20 * 60 * 1000, () => {
  const db = globalDb;
  const staleKeepAlive = new Date(Date.now() - 3 * KEEP_ALIVE_INTERVAL_MILLIS);
  const jobs = db.getReadyScheduledJobs(staleKeepAlive);

  const promises = [];

  jobs.forEach((job) => {
    if (job.lastKeepAlive) {
      if (job.retries && job.retries >= MAX_DISCONNECTED_RETRIES) {
        db.recordScheduleJobRan(job, {
          finished: job.lastKeepAlive,
          type: "disconnected",
          message: "MAX_DISCONNECTED_RETRIES exceeded",
        });
      } else {
        db.scheduledJobIncrementRetries(job._id);
      }
    }

    const token = fetchApiToken(db, job.runnable);
    if (!token) {
      throw new Error("could not find ApiToken for runnable", job.runnable);
    }

    let intervalHandle;

    promises.push(Promise.resolve().then(() => {
      let runnable = restoreInternal(db, job.runnable, { frontend: null }, [], token).cap;
      runnable = runnable.castAs(Runnable);

      intervalHandle = Meteor.setInterval(() => {
        globalBackend.useGrain(job.grainId, (supervisor) => {
          waitPromise(supervisor.keepAlive());
        });
        db.updateScheduledJobKeepAlive(job._id);
      }, KEEP_ALIVE_INTERVAL_MILLIS);

      return runnable.run();
    }).then(() => {
      db.recordScheduledJobRan(job);
    }, (e) => {
      if (e.kjType === "disconnected") {
        db.scheduledJobIncrementRetries(job._id);
      } else {
        const type = e.kjType || "failed";
        db.recordScheduledJobRan(job, {
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
  });

  waitPromise(Promise.all(promises));
});

SandstormDb.periodicCleanup(25 * 60 * 1000, () => {
  globalDb.deleteUnconfirmedScheduledJobs();
});
