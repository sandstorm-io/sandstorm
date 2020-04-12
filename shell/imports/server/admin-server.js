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

import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import { _ } from "meteor/underscore";
import { Accounts } from "meteor/accounts-base";
import { Random } from "meteor/random";

import Fs from "fs";
import Crypto from "crypto";
import Heapdump from "heapdump";
import { SANDSTORM_LOGDIR } from "/imports/server/constants.js";
import { clearAdminToken, checkAuth, tokenIsValid, tokenIsSetupSession } from "/imports/server/auth.js";
import { send as sendEmail } from "/imports/server/email.js";
import { fillUndefinedForChangedDoc } from "/imports/server/observe-helpers.js";
import { SandstormDb } from "/imports/sandstorm-db/db.js";
import { globalDb } from "/imports/db-deprecated.js";
import { computeStats } from "/imports/server/stats-server.js";

const publicAdminSettings = [
  "google", "github", "ldap", "saml", "emailToken", "splashUrl", "signupDialog",
  "adminAlert", "adminAlertTime", "adminAlertUrl", "termsUrl",
  "privacyUrl", "appMarketUrl", "appIndexUrl", "appUpdatesEnabled",
  "serverTitle", "returnAddress", "ldapNameField", "organizationMembership",
  "organizationSettings",
  "whitelabelCustomLoginProviderName",
  "whitelabelCustomLogoAssetId",
  "whitelabelHideSendFeedback",
  "whitelabelHideTroubleshooting",
  "whiteLabelHideAbout",
  "whitelabelUseServerTitleForHomeText",
  "quotaEnabled",
  "quotaLdapEnabled",
  "billingPromptUrl",
];

const smtpConfigShape = {
  hostname: String,
  port: Number,
  auth: {
    user: String,
    pass: String,
  },
  returnAddress: String,
};

Meteor.methods({
  setAccountSetting: function (token, serviceName, value) {
    checkAuth(token);
    check(serviceName, String);
    check(value, Boolean);

    // Only check configurations for OAuth services.
    const oauthServices = ["google", "github"];
    if (value && (oauthServices.indexOf(serviceName) != -1)) {
      const config = ServiceConfiguration.configurations.findOne({ service: serviceName });
      if (!config) {
        throw new Meteor.Error(403, "You must configure the " + serviceName +
          " service before you can enable it. Click the \"configure\" link.");
      }

      if (!config.clientId || !config.secret) {
        throw new Meteor.Error(403, "You must provide a non-empty clientId and secret for the " +
          serviceName + " service before you can enable it. Click the \"configure\" link.");
      }
    }

    globalDb.collections.settings.upsert({ _id: serviceName }, { $set: { value: value } });
    if (value) {
      globalDb.collections.settings.update({ _id: serviceName }, { $unset: { automaticallyReset: 1 } });
    }
  },

  setSmtpConfig: function (token, config) {
    checkAuth(token);
    check(config, smtpConfigShape);

    globalDb.collections.settings.upsert({ _id: "smtpConfig" }, { $set: { value: config } });
  },

  disableEmail: function (token) {
    checkAuth(token);

    const db = this.connection.sandstormDb;
    db.collections.settings.update({ _id: "smtpConfig" }, { $set: { "value.hostname": "" } });
  },

  setSetting: function (token, name, value) {
    checkAuth(token);
    check(name, String);
    check(value, Match.OneOf(null, String, Date, Boolean));

    globalDb.collections.settings.upsert({ _id: name }, { $set: { value: value } });
  },

  saveOrganizationSettings(token, params) {
    checkAuth(token);
    check(params, {
      membership: {
        emailToken: {
          enabled: Boolean,
          domain: String,
        },
        google: {
          enabled: Boolean,
          domain: String,
        },
        ldap: {
          enabled: Boolean,
        },
        saml: {
          enabled: Boolean,
        },
      },
      settings: {
        disallowGuests: Boolean,
        shareContacts: Boolean,
      },
    });

    this.connection.sandstormDb.collections.settings.upsert({ _id: "organizationMembership" }, { value: params.membership });
    this.connection.sandstormDb.collections.settings.upsert({ _id: "organizationSettings" }, { value: params.settings });
  },

  adminConfigureLoginService: function (token, options) {
    checkAuth(token);
    check(options, Match.ObjectIncluding({ service: String }));

    ServiceConfiguration.configurations.upsert({ service: options.service }, options);
  },

  clearResumeTokensForService: function (token, serviceName) {
    checkAuth(token);
    check(serviceName, String);

    const query = {};
    query["services." + serviceName] = { $exists: true };
    Meteor.users.find(query).forEach(function (credential) {
      if (credential.services.resume && credential.services.resume.loginTokens &&
          credential.services.resume.loginTokens.length > 0) {
        Meteor.users.update({ _id: credential._id }, { $set: { "services.resume.loginTokens": [] } });
      }

      Meteor.users.update({ "loginCredentials.id": credential._id },
                          { $set: { "services.resume.loginTokens": [] } });
    });
  },

  adminUpdateUser: function (token, userInfo) {
    checkAuth(token);
    check(userInfo, {
      userId: String,
      signupKey: Boolean,
      isAdmin: Boolean,
    });

    const userId = userInfo.userId;
    if (userId === Meteor.userId() && !userInfo.isAdmin) {
      throw new Meteor.Error(403, "User cannot remove admin permissions from itself.");
    }

    Meteor.users.update({ _id: userId }, { $set: _.omit(userInfo, ["_id", "userId"]) });
  },

  testSend: function (token, smtpConfig, to) {
    checkAuth(token);
    check(smtpConfig, smtpConfigShape);
    check(to, String);
    const { returnAddress, ...restConfig } = smtpConfig;

    try {
      sendEmail({
        to: to,
        from: { name: globalDb.getServerTitle(), address: returnAddress },
        subject: "Testing your Sandstorm's SMTP setting",
        text: "Success! Your outgoing SMTP is working.",
        smtpConfig: restConfig,
      });
    } catch (e) {
      // Attempt to give more accurate error messages for a variety of known failure modes,
      // and the actual exception data in the event a user hits a new failure mode.
      if (e.syscall === "getaddrinfo") {
        if (e.code === "EIO" || e.code === "ENOTFOUND") {
          throw new Meteor.Error("getaddrinfo " + e.code, "Couldn't resolve \"" + smtpConfig.hostname + "\" - check for typos or broken DNS.");
        }
      } else if (e.syscall === "connect") {
        if (e.code === "ECONNREFUSED") {
          throw new Meteor.Error("connect ECONNREFUSED", "Server at " + smtpConfig.hostname + ":" + smtpConfig.port + " refused connection.  Check your settings, firewall rules, and that your mail server is up.");
        }
      } else if (e.name === "AuthError") {
        throw new Meteor.Error("auth error", "Authentication failed.  Check your credentials.  Message from " +
                smtpConfig.hostname + ": " + e.data);
      }

      throw new Meteor.Error("other-email-sending-error", "Error while trying to send test email: " + JSON.stringify(e));
    }
  },

  createSignupKey: function (token, note, quota) {
    checkAuth(token);
    check(note, String);
    check(quota, Match.OneOf(undefined, null, Number));

    const key = Random.id();
    const content = { _id: key, used: false, note: note };
    if (typeof quota === "number") content.quota = quota;
    globalDb.collections.signupKeys.insert(content);
    return key;
  },

  sendInvites: function (token, origin, from, list, subject, message, quota) {
    checkAuth(token);
    check(from, { name: String, address: String });
    check([origin, list, subject, message], [String]);
    check(quota, Match.OneOf(undefined, null, Number));

    if (!from.address.trim()) {
      throw new Meteor.Error(403, "Must enter 'from' address.");
    }

    if (!list.trim()) {
      throw new Meteor.Error(403, "Must enter 'to' addresses.");
    }

    this.unblock();

    list = list.split("\n");
    for (const i in list) {
      const email = list[i].trim();

      if (email) {
        const key = Random.id();

        const content = {
          _id: key,
          used: false,
          note: "E-mail invite to " + email,
          email: email,
          definitelySent: false,
        };
        if (typeof quota === "number") content.quota = quota;
        globalDb.collections.signupKeys.insert(content);
        sendEmail({
          to: email,
          from: from,
          envelopeFrom: globalDb.getReturnAddress(),
          subject: subject,
          text: message.replace(/\$KEY/g, origin + "/signup/" + key),
        });
        globalDb.collections.signupKeys.update(key, { $set: { definitelySent: true } });
      }
    }

    return { sent: true };
  },

  adminToggleDisableCap: function (token, capId, value) {
    checkAuth(token);
    check(capId, String);
    check(value, Boolean);

    if (value) {
      globalDb.collections.apiTokens.update({ _id: capId }, { $set: { revoked: true } });
    } else {
      globalDb.collections.apiTokens.update({ _id: capId }, { $set: { revoked: false } });
    }
  },

  updateQuotas: function (token, list, quota) {
    checkAuth(token);
    check(list, String);
    check(quota, Match.OneOf(undefined, null, Number));

    if (!list.trim()) {
      throw new Meteor.Error(400, "Must enter addresses.");
    }

    const items = list.split("\n");
    const invalid = [];
    for (const i in items) {
      const modifier = (typeof quota === "number") ? { $set: { quota: quota } }
                                                 : { $unset: { quota: "" } };
      let n = globalDb.collections.signupKeys.update({ email: items[i] }, modifier, { multi: true });
      n += Meteor.users.update({ signupEmail: items[i] }, modifier, { multi: true });

      if (n < 1) invalid.push(items[i]);
    }

    if (invalid.length > 0) {
      throw new Meteor.Error(404, "These addresses did not map to any user nor invite: " +
          invalid.join(", "));
    }
  },

  dismissAdminStatsNotifications: function (token) {
    checkAuth(token);
    globalDb.collections.notifications.remove({ "admin.type": "reportStats" });
  },

  signUpAsAdmin: function (token) {
    check(token, String);
    checkAuth(token);
    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to sign up as admin.");
    }

    if (!Meteor.user().loginCredentials) {
      throw new Meteor.Error(403, "Must be logged into an account to sign up as admin.");
    }

    Meteor.users.update({ _id: this.userId }, { $set: { isAdmin: true, signupKey: "admin" } });
    clearAdminToken(token);
  },

  redeemSetupToken(token) {
    // Redeem an admin token into a setup session.
    check(token, String);
    if (tokenIsValid(token)) {
      const sessId = Random.secret();
      const creationDate = new Date();
      const hashedSessionId = Crypto.createHash("sha256").update(sessId).digest("base64");
      this.connection.sandstormDb.collections.setupSession.upsert({
        _id: "current-session",
      }, {
        creationDate,
        hashedSessionId,
      });
      // Then, invalidate the token, so one one else can use it.
      clearAdminToken(token);
      return sessId;
    } else {
      throw new Meteor.Error(401, "Invalid setup token");
    }
  },

  heapdump() {
    // Requests a heap dump. Intended for use by Sandstorm developers. Requires admin.
    //
    // Call this from the JS console like:
    //   Meteor.call("heapdump");

    checkAuth();

    // We use /var/log because it's a location in the container to which the front-end is allowed
    // to write.
    const name = "/var/log/" + Date.now() + ".heapsnapshot";
    Heapdump.writeSnapshot(name);
    console.log("Wrote heapdump: /opt/sandstorm" + name);
    return name;
  },

  setPreinstalledApps: function (appAndPackageIds) {
    checkAuth();
    check(appAndPackageIds, [{ appId: String, packageId: String, }]);

    this.connection.sandstormDb.setPreinstalledApps(appAndPackageIds);
  },

  setTlsKeys: function (keys) {
    checkAuth();
    check(keys, {
      key: String,
      certChain: String
    });

    if (currentTlsKeysCallback) {
      // Validate by calling setKeys() directly.
      currentTlsKeysCallback.setKeys(keys.key, keys.certChain).await();
    }

    globalDb.collections.settings.upsert({ _id: "tlsKeys" }, { $set: { value: keys } });
  },
});

const authorizedAsAdmin = function (token, userId) {
  return Match.test(token, Match.OneOf(undefined, null, String)) &&
         ((userId && isAdminById(userId)) || tokenIsValid(token) || tokenIsSetupSession(token));
};

Meteor.publish("admin", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];

  // Admin is allowed to see all settings... but we redact the TLS key out of caution.
  return globalDb.collections.settings.find({ _id: { $ne: "tlsKeys" } });
});

Meteor.publish("adminServiceConfiguration", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return ServiceConfiguration.configurations.find();
});

Meteor.publish("publicAdminSettings", function () {
  return globalDb.collections.settings.find({ _id: { $in: publicAdminSettings } });
});

Meteor.publish("adminToken", function (token) {
  check(token, String);
  this.added("adminToken", "adminToken", { tokenIsValid: tokenIsValid(token) || tokenIsSetupSession(token) });
  this.ready();
});

Meteor.publish("allUsers", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return Meteor.users.find();
});

Meteor.publish("adminUserDetails", function (userId) {
  if (!authorizedAsAdmin(undefined, this.userId)) return [];

  // Reactive publish of any credentials owned by the account with id userId,
  // as well as that user object itself.
  const credentialSubs = {};
  const accountId = userId;

  const unrefCredential = (credentialId) => {
    if (!credentialSubs[credentialId]) {
      // should never happen, but if somehow you attempt to unref an credential that we don't have a
      // subscription to, then don't crash
      console.error("attempted to unref untracked credential id:", credentialId);
      return;
    }

    const observeHandle = credentialSubs[credentialId];
    delete credentialSubs[credentialId];
    observeHandle.stop();
    this.removed("users", credentialId);
  };

  const refCredential = (credentialId) => {
    if (credentialSubs[credentialId]) {
      // should never happen, but if somehow an account wound up with a duplicate credential ID,
      // avoid leaking a subscription
      console.error("duplicate credential id:", credentialId);
      return;
    }

    const cursor = Meteor.users.find({ _id: credentialId });
    const observeHandle = cursor.observe({
      added: (doc) => {
        this.added("users", doc._id, doc);
      },

      changed: (newDoc, oldDoc) => {
        fillUndefinedForChangedDoc(newDoc, oldDoc);
        this.changed("users", newDoc._id, newDoc);
      },

      removed: (oldDoc) => {
        this.removed("users", oldDoc._id);
      },
    });

    credentialSubs[credentialId] = observeHandle;
  };

  const accountCursor = Meteor.users.find({ _id: accountId });
  const accountSubHandle = accountCursor.observe({
    added: (newDoc) => {
      const newCredentials = SandstormDb.getUserCredentialIds(newDoc);
      newCredentials.forEach((credentialId) => {
        refCredential(credentialId);
      });

      this.added("users", newDoc._id, newDoc);
    },

    changed: (newDoc, oldDoc) => {
      const newCredentials = SandstormDb.getUserCredentialIds(newDoc);
      const oldCredentials = SandstormDb.getUserCredentialIds(oldDoc);

      // Those in newDoc - oldDoc, ref.
      const credentialsAdded = _.difference(newCredentials, oldCredentials);
      credentialsAdded.forEach((credentialId) => {
        refCredential(credentialId);
      });

      // Those in oldDoc - newDoc, unref.
      const credentialsRemoved = _.difference(oldCredentials, newCredentials);
      credentialsRemoved.forEach((credentialId) => {
        unrefCredential(credentialId);
      });

      fillUndefinedForChangedDoc(newDoc, oldDoc);

      this.changed("users", newDoc._id, newDoc);
    },

    removed: (oldDoc) => {
      this.removed("users", oldDoc._id);
      const oldCredentials = SandstormDb.getUserCredentialIds(oldDoc);
      oldCredentials.forEach((credentialId) => {
        unrefCredential(credentialId);
      });
    },
  });

  this.onStop(() => {
    accountSubHandle.stop();
    // Also stop all the credential subscriptions.
    const subs = _.values(credentialSubs);
    subs.forEach((sub) => {
      sub.stop();
    });
  });

  // Meteor's cursor.observe() will synchronously call all of the added() callbacks from the initial
  // query, so by the time we get here we can report readiness.
  this.ready();
});

Meteor.publish("activityStats", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return globalDb.collections.activityStats.find();
});

Meteor.publish("statsTokens", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return globalDb.collections.statsTokens.find();
});

Meteor.publish("allPackages", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return globalDb.collections.packages.find({ manifest: { $exists: true } },
      { fields: { appId: 1, "manifest.appVersion": 1,
      "manifest.actions": 1, "manifest.appTitle": 1, progress: 1, status: 1, }, });
});

Meteor.publish("realTimeStats", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];

  // Last five minutes.
  this.added("realTimeStats", "now", computeStats(new Date(Date.now() - 5 * 60 * 1000)));

  // Since last sample.
  const lastSample = globalDb.collections.activityStats.findOne({}, { sort: { timestamp: -1 } });
  const lastSampleTime = lastSample ? lastSample.timestamp : new Date(0);
  this.added("realTimeStats", "today", computeStats(lastSampleTime));

  // TODO(someday): Update every few minutes?

  this.ready();
});

Meteor.publish("adminLog", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];

  const logfile = SANDSTORM_LOGDIR + "/sandstorm.log";

  const fd = Fs.openSync(logfile, "r");
  const startSize = Fs.fstatSync(fd).size;

  // Difference between the current file offset and the subscription offset. Can be non-zero when
  // logs have rotated.
  let extraOffset = 0;

  if (startSize < 8192) {
    // Log size is less than window size. Check for rotated log and grab its tail.
    const logfile1 = SANDSTORM_LOGDIR + "/sandstorm.log.1";
    if (Fs.existsSync(logfile1)) {
      const fd1 = Fs.openSync(logfile1, "r");
      const startSize1 = Fs.fstatSync(fd1).size;
      const amountFromLog1 = Math.min(startSize1, 8192 - startSize);
      const offset1 = startSize1 - amountFromLog1;
      const buf = new Buffer(amountFromLog1);
      const n = Fs.readSync(fd1, buf, 0, buf.length, offset);
      if (n > 0) {
        this.added("adminLog", 0, { text: buf.toString("utf8", 0, n) });
        extraOffset += n;
      }
    }
  }

  // Start tailing at EOF - 8k.
  let offset = Math.max(0, startSize - 8192);

  const _this = this;
  function doTail() {
    if (Fs.fstatSync(fd).size < offset) {
      extraOffset += offset;
      offset = 0;
    }

    for (;;) {
      const buf = new Buffer(Math.max(1024, startSize - offset));
      const n = Fs.readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      _this.added("adminLog", offset + extraOffset, { text: buf.toString("utf8", 0, n) });
      offset += n;
    }
  }

  // Watch the file for changes.
  const watcher = Fs.watch(logfile, { persistent: false }, Meteor.bindEnvironment(doTail));

  // When the subscription stops, stop watching the file.
  this.onStop(function () {
    watcher.close();
    Fs.closeSync(fd);
  });

  // Read initial 8k tail data immediately.
  doTail();

  // Notify ready.
  this.ready();
});

Meteor.publish("adminApiTokens", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return globalDb.collections.apiTokens.find({
    $or: [
      { "frontendRef.ipNetwork": { $exists: true } },
      { "frontendRef.ipInterface": { $exists: true } },
    ],
  }, {
    fields: {
      frontendRef: 1,
      created: 1,
      requirements: 1,
      revoked: 1,
      owner: 1,
    },
  });
});

Meteor.publish("hasAdmin", function (token) {
  // Like hasUsers, but for admins, and with token auth required.
  if (!authorizedAsAdmin(token, this.userId)) return [];

  // Query if there are any admin users.
  const cursor = Meteor.users.find({ isAdmin: true });
  if (cursor.count() > 0) {
    this.added("hasAdmin", "hasAdmin", { hasAdmin: true });
  } else {
    let handle = cursor.observeChanges({
      added: (id) => {
        this.added("hasAdmin", "hasAdmin", { hasAdmin: true });
        handle.stop();
        handle = null;
      },
    });
    this.onStop(function () {
      if (handle) handle.stop();
    });
  }

  this.ready();
});

Meteor.publish("appIndexAdmin", function (token) {
  if (!authorizedAsAdmin(token, this.userId)) return [];
  return globalDb.collections.appIndex.find();
});

function observeOauthService(name) {
  globalDb.collections.settings.find({ _id: name, value: true }).observe({
    added: function () {
      // Tell the oauth library it should accept login attempts from this service.
      Accounts.oauth.registerService(name);
    },

    removed: function () {
      // Tell the oauth library it should deny login attempts from this service.
      Accounts.oauth.unregisterService(name);
    },
  });
}

observeOauthService("github");
observeOauthService("google");
