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

import Crypto from "crypto";
import { Match, check } from "meteor/check";
import Capnp from "/imports/server/capnp";
import { SandstormDb } from "./db";

const MINIMUM_SCHEDULING_SLACK_NANO = Capnp.importSystem("sandstorm/grain.capnp").minimumSchedulingSlack;

const PERIOD_MILLIS = {
  yearly:  1000 * 60 * 60 * 24 * 365,
  monthly: 1000 * 60 * 60 * 24 * 30,
  weekly:  1000 * 60 * 60 * 24 * 7,
  daily:   1000 * 60 * 60 * 24,
  hourly:  1000 * 60 * 60,
};

const LEGAL_PERIODS = Object.getOwnPropertyNames(PERIOD_MILLIS);

SandstormDb.prototype.requireSpareScheduledJobs = async function (grainId) {
  if (await this.collections.scheduledJobs.find({ grainId }).countAsync() > 50) {
    throw new Error("grain already has the maximum allowed number of jobs");
  }
}

SandstormDb.prototype.addOneShotScheduledJob = async function(grainId, name, callback, when, slack) {
  // Strictly speaking, we don't need to check these since they came from
  // a capnp call (and thus were unmarshalled by trusted code), but we may
  // as well since it's easy. We skip `name` though, since there's not a handy
  // way to validate a LocalizedText.
  check(grainId, String);
  check(when, String);
  check(slack, String);
  check(callback, String);

  await this.requireSpareScheduledJobs(grainId);

  const whenNano = parseInt(when);
  let slackNano = parseInt(slack);

  const nowMillis = Date.now();
  const nowNano = nowMillis * 1e6;
  if(whenNano < nowNano) {
    throw new Error("Can't schedule a job for a time in the past.");
  }
  // For details on the why of this computation, see the comments in
  // grain.capnp for ScheduledJob:
  if(slackNano === 0) {
    slackNano = (whenNano - nowNano) / 8;
  }
  slackNano = Math.max(slackNano, MINIMUM_SCHEDULING_SLACK_NANO);

  // pick a random time in the allowed interval:
  const scheduledTimeNano = whenNano + Math.random() * slackNano;

  const scheduledTimeMillis = scheduledTimeNano / 1e6;
  const nextPeriodStart = new Date(scheduledTimeMillis);

  await this.collections.scheduledJobs.insertAsync({
    created: new Date(),
    grainId,
    name,
    callback,
    nextPeriodStart,
  });
}

SandstormDb.prototype.addPeriodicScheduledJob = async function (grainId, name, callback, period) {
  check(grainId, String);
  // FIXME(zenhack): check that name is a LocalizedText (how?)
  check(callback, String);
  check(period, Match.OneOf(...LEGAL_PERIODS));
  await this.requireSpareScheduledJobs(grainId);

  // Randomize the initial start time by adding up to half of the scheduling period.
  // This should help to spread out jobs throughout the available scheduling time, even
  // if `schedulePeriodic()` gets called with a non-uniform time distribution.
  const nowMillis = Date.now();
  const nextPeriodStart =
    new Date(Math.floor(nowMillis + Math.random() * PERIOD_MILLIS[period] / 2));

  return await this.collections.scheduledJobs.insertAsync({
    created: new Date(),
    grainId,
    name,
    callback,
    period,
    nextPeriodStart,
  });
};

SandstormDb.prototype.deleteScheduledJob = async function (jobId) {
  check(jobId, String);
  const job = await this.collections.scheduledJobs.findOneAsync({ _id: jobId });
  await this.collections.scheduledJobs.removeAsync({ _id: jobId });
  const tokenId = Crypto.createHash("sha256").update(job.callback).digest("base64");
  await this.removeApiTokens({ _id: tokenId });
};

SandstormDb.prototype.updateScheduledJobKeepAlive = async function (id) {
  check(id, String);
  const now = new Date();
  await this.collections.scheduledJobs.updateAsync(
    { _id: id },
    { $set: { lastKeepAlive: now } });
};

SandstormDb.prototype.recordScheduledJobRan = async function (job, maybeError) {
  check(job, Match.ObjectIncluding({
    _id: String,
    period: Match.OneOf(...LEGAL_PERIODS),
    nextPeriodStart: Date,
  }));

  check(maybeError, Match.OneOf(null, undefined, {
    finished: Date,
    type: Match.OneOf("disconnected", "failed", "overloaded", "unimplemented"),
    message: Match.Optional(String),
  }));

  let nextPeriodStartMillis = job.nextPeriodStart.getTime();
  const nowMillis = Date.now();
  if (nowMillis > nextPeriodStartMillis) {

    // Roll the nextPeriodStart field forward. Skip past any periods that have already
    // elapsed.
    nextPeriodStartMillis += PERIOD_MILLIS[job.period] *
      Math.ceil((nowMillis - nextPeriodStartMillis) / PERIOD_MILLIS[job.period]);
  }

  const nextPeriodStart = new Date(nextPeriodStartMillis);

  const setter = { nextPeriodStart };
  if (maybeError) {
    setter.previousError = maybeError;
  }

  await this.collections.scheduledJobs.updateAsync(
    { _id: job._id },
    { $unset: { lastKeepAlive: true, retries: true },
      $set: setter,
    });
};

SandstormDb.prototype.scheduledJobIncrementRetries = async function (id) {
  check(id, String);

  await this.collections.scheduledJobs.updateAsync(
    { _id: id },
    { $inc: { retries: 1 },
      $unset: { lastKeepAlive: true },
    });
};

SandstormDb.prototype.getReadyScheduledJobs = async function (nowMillis, staleKeepAlive) {
  check(staleKeepAlive, Date);

  const now = new Date(nowMillis);
  return await this.collections.scheduledJobs.find({
    nextPeriodStart: { $lt: now },
    $or: [{ lastKeepAlive: { $exists: false } },
          { lastKeepAlive: { $lt: staleKeepAlive } },
         ],
  }).fetchAsync();
};
