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
import { omit, difference } from "/imports/shared/collection-utils";
import { Accounts } from "meteor/accounts-base";
import { Random } from "meteor/random";
import { ServiceConfiguration } from "meteor/service-configuration";

import Fs from "fs";
import Crypto from "crypto";
import { writeHeapSnapshot } from "v8";
import { SANDSTORM_LOGDIR } from "/imports/server/constants";
import { clearAdminToken, checkAuthAsync, tokenIsValid, tokenIsSetupSessionAsync } from "/imports/server/auth";
import { send as sendEmail } from "/imports/server/email";
import { fillUndefinedForChangedDoc } from "/imports/server/observe-helpers";
import { SandstormDb } from "/imports/sandstorm-db/db";
import { globalDb } from "/imports/db-deprecated";
import { computeStats } from "/imports/server/stats-server";
import { httpCallAsync } from "/imports/server/http-helpers";
import { createAcmeAccount, renewCertificateNow } from "/imports/server/acme";
import { Issuer } from "openid-client";

let adminEmailSender = sendEmail;

export function setAdminEmailSenderForTests(sender) {
  adminEmailSender = sender || sendEmail;
}

const publicAdminSettings = [
  "google", "github", "ldap", "oidc", "saml", "emailToken", "splashUrl", "signupDialog",
  "adminAlert", "adminAlertTime", "adminAlertUrl", "termsUrl",
  "privacyUrl", "appMarketUrl", "appIndexUrl", "appUpdatesEnabled",
  "devAccounts",
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
  setAccountSetting: async function (token, serviceName, value) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    check(serviceName, String);
    check(value, Boolean);

    // Only check configurations for OAuth services.
    const oauthServices = ["google", "github", "oidc"];
    if (value && (oauthServices.indexOf(serviceName) != -1)) {
      const config = await ServiceConfiguration.configurations.findOneAsync({ service: serviceName });
      if (!config) {
        throw new Meteor.Error(403, "You must configure the " + serviceName +
          " service before you can enable it. Click the \"configure\" link.");
      }

      if (!config.clientId || !config.secret) {
        throw new Meteor.Error(403, "You must provide a non-empty clientId and secret for the " +
          serviceName + " service before you can enable it. Click the \"configure\" link.");
      }

      if (serviceName === "oidc") {
        if (!config.serverUrl || !config.clientAuthMethod || !config.issuer) {
          throw new Meteor.Error(403, "You must provide a full set of server parameters for the " +
            serviceName + " service before you can enable it. Click the \"configure\" link.");
        }
      }
    }

    await globalDb.collections.settings.upsertAsync({ _id: serviceName }, { $set: { value: value } });
    if (value) {
      await globalDb.collections.settings.updateAsync(
          { _id: serviceName }, { $unset: { automaticallyReset: 1 } });
    }
  },

  setSmtpConfig: async function (token, config) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    check(config, smtpConfigShape);

    await globalDb.collections.settings.upsertAsync({ _id: "smtpConfig" }, { $set: { value: config } });
  },

  disableEmail: async function (token) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);

    const db = this.connection.sandstormDb;
    await db.collections.settings.updateAsync({ _id: "smtpConfig" }, { $set: { "value.hostname": "" } });
  },

  setSetting: async function (token, name, value) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    check(name, String);
    check(value, Match.OneOf(null, String, Date, Boolean));

    await globalDb.collections.settings.upsertAsync({ _id: name }, { $set: { value: value } });
  },

  async saveOrganizationSettings(token, params) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
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
        oidc: {
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

    await this.connection.sandstormDb.collections.settings.upsertAsync(
        { _id: "organizationMembership" }, { value: params.membership });
    await this.connection.sandstormDb.collections.settings.upsertAsync(
        { _id: "organizationSettings" }, { value: params.settings });
  },

  adminConfigureLoginService: async function (token, options) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    check(options, Match.ObjectIncluding({ service: String }));

    if (options.service === "oidc" && options.serverUrl) {
      return Issuer.discover(options.serverUrl).then(async function(issuer) {

        // 'Proof Key for Code Exchange' (response_type === 'code') is not yet supported.
        // An additional code_challenge parameter would have to be added when generating the authorizationUrl.
        if (issuer.metadata.response_types_supported.indexOf("id_token") === -1) {
          throw new Meteor.Error(403, "The provided identity server does not support the 'id_token' response type.");
        }

        options.issuer = issuer.metadata;
        await ServiceConfiguration.configurations.upsertAsync({ service: options.service }, options);
      }).catch(function(_err) {
        throw new Meteor.Error(403, "Could not discover an OpenID Connect endpoint at the provided URL.");
      });
    } else {
      await ServiceConfiguration.configurations.upsertAsync({ service: options.service }, options);
    }
  },

  clearResumeTokensForService: async function (token, serviceName) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    check(serviceName, String);

    const query = {};
    query["services." + serviceName] = { $exists: true };
    const credentials = await Meteor.users.find(query).fetchAsync();
    for (const credential of credentials) {
      if (credential.services.resume && credential.services.resume.loginTokens &&
          credential.services.resume.loginTokens.length > 0) {
        await Meteor.users.updateAsync(
            { _id: credential._id }, { $set: { "services.resume.loginTokens": [] } });
      }

      await Meteor.users.updateAsync({ "loginCredentials.id": credential._id },
                                     { $set: { "services.resume.loginTokens": [] } });
    }
  },

  adminUpdateUser: async function (token, userInfo) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    check(userInfo, {
      userId: String,
      signupKey: Boolean,
      isAdmin: Boolean,
    });

    const userId = userInfo.userId;
    if (userId === Meteor.userId() && !userInfo.isAdmin) {
      throw new Meteor.Error(403, "User cannot remove admin permissions from itself.");
    }

    await Meteor.users.updateAsync({ _id: userId }, { $set: omit(userInfo, ["_id", "userId"]) });
  },

  testSend: async function (token, smtpConfig, to) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    check(smtpConfig, smtpConfigShape);
    check(to, String);
    const { returnAddress, ...restConfig } = smtpConfig;

    try {
      await adminEmailSender({
        to: to,
        from: { name: await globalDb.getServerTitleAsync(), address: returnAddress },
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

  createSignupKey: async function (token, note, quota) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    check(note, String);
    check(quota, Match.OneOf(undefined, null, Number));

    const key = Random.id();
    const content = { _id: key, used: false, note: note };
    if (typeof quota === "number") content.quota = quota;
    await globalDb.collections.signupKeys.insertAsync(content);
    return key;
  },

  sendInvites: async function (token, origin, from, list, subject, message, quota) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
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
        await globalDb.collections.signupKeys.insertAsync(content);
        await adminEmailSender({
          to: email,
          from: from,
          envelopeFrom: await globalDb.getReturnAddressAsync(),
          subject: subject,
          text: message.replace(/\$KEY/g, origin + "/signup/" + key),
        });
        await globalDb.collections.signupKeys.updateAsync(key, { $set: { definitelySent: true } });
      }
    }

    return { sent: true };
  },

  adminToggleDisableCap: async function (token, capId, value) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    check(capId, String);
    check(value, Boolean);

    if (value) {
      await globalDb.collections.apiTokens.updateAsync({ _id: capId }, { $set: { revoked: true } });
    } else {
      await globalDb.collections.apiTokens.updateAsync({ _id: capId }, { $set: { revoked: false } });
    }
  },

  updateQuotas: async function (token, list, quota) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
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
      let n = await globalDb.collections.signupKeys.updateAsync({ email: items[i] }, modifier, { multi: true });
      n += await Meteor.users.updateAsync({ signupEmail: items[i] }, modifier, { multi: true });

      if (n < 1) invalid.push(items[i]);
    }

    if (invalid.length > 0) {
      throw new Meteor.Error(404, "These addresses did not map to any user nor invite: " +
          invalid.join(", "));
    }
  },

  dismissAdminStatsNotifications: async function (token) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    await globalDb.collections.notifications.removeAsync({ "admin.type": "reportStats" });
  },

  signUpAsAdmin: async function (token) {
    check(token, String);
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to sign up as admin.");
    }

    const account = await Meteor.users.findOneAsync({ _id: this.userId });
    if (!account || !account.loginCredentials) {
      throw new Meteor.Error(403, "Must be logged into an account to sign up as admin.");
    }

    await Meteor.users.updateAsync({ _id: this.userId }, { $set: { isAdmin: true, signupKey: "admin" } });
    await clearAdminToken(token);
  },

  async redeemSetupToken(token) {
    // Redeem an admin token into a setup session.
    check(token, String);
    if (tokenIsValid(token)) {
      const sessId = Random.secret();
      const creationDate = new Date();
      const hashedSessionId = Crypto.createHash("sha256").update(sessId).digest("base64");
      await this.connection.sandstormDb.collections.setupSession.upsertAsync({
        _id: "current-session",
      }, {
        creationDate,
        hashedSessionId,
      });
      // Then, invalidate the token, so one one else can use it.
      await clearAdminToken(token);
      return sessId;
    } else {
      throw new Meteor.Error(401, "Invalid setup token");
    }
  },

  async heapdump() {
    // Requests a heap dump. Intended for use by Sandstorm developers. Requires admin.
    //
    // Call this from the JS console like:
    //   Meteor.call("heapdump");

    await checkAuthAsync(this.connection.sandstormDb, this.userId);

    // We use /var/log because it's a location in the container to which the front-end is allowed
    // to write.
    const name = "/var/log/" + Date.now() + ".heapsnapshot";
    writeHeapSnapshot(name);
    console.log("Wrote heapdump: /opt/sandstorm" + name);
    return name;
  },

  setPreinstalledApps: async function (appAndPackageIds) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId);
    check(appAndPackageIds, [{ appId: String, packageId: String, }]);

    await this.connection.sandstormDb.setPreinstalledApps(appAndPackageIds);
  },

  setTlsKeys: async function (token, keys) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    check(keys, {
      key: String,
      certChain: String
    });

    if (globalThis.currentTlsKeysCallback) {
      // Validate by calling setKeys() directly.
      await globalThis.currentTlsKeysCallback.setKeys(keys.key, keys.certChain);
    }

    await globalDb.collections.settings.upsertAsync({ _id: "tlsKeys" }, { $set: { value: keys } });
  },

  forgetAcmeAccount: async function (token) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    await globalDb.collections.settings.removeAsync({ _id: "acmeAccount" });
  },

  forgetAcmeChallenge: async function (token) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    await globalDb.collections.settings.removeAsync({ _id: "acmeChallenge" });
  },

  fetchAcmeDirectory: async function (token, url) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    check(url, String);
    let response = await httpCallAsync("GET", url, { ssrfSafeDb: globalDb });

    if (response.statusCode != 200) {
      throw new Meteor.Error("bad_acme_directory",
          "Directory service responded with status code: " + response.statusCode);
    }
    if (!response.data) {
      throw new Meteor.Error("bad_acme_directory",
          "Directory service didn't return JSON.");
    }

    return response.data;
  },

  createAcmeAccount: async function (token, directory, email, agreeToTerms) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    check(directory, String);
    check(email, String);
    check(agreeToTerms, Boolean);

    try {
      await createAcmeAccount(directory, email, agreeToTerms);
    } catch (err) {
      throw new Meteor.Error("couldnt_create_acme_account", err.message);
    }
  },

  setAcmeChallenge: async function (token, module, options) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    check(module, ModuleName);
    check(options, Object);

    options = SandstormDb.escapeMongoObject(options);

    await globalDb.collections.settings.upsertAsync({_id: "acmeChallenge"},
        {$set: { value: { module, options } }});
  },

  renewCertificateNow: async function (token) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId, token);
    this.unblock();

    try {
      await renewCertificateNow();
    } catch (err) {
      throw new Meteor.Error("couldnt_renew_cert", err.message);
    }
  }
});

let ModuleName = Match.Where(name => {
  check(name, String);
  return !!name.match(/^[a-zA-Z0-9_-]*$/);
});

const authorizedAsAdmin = async function (token, userId) {
  return Match.test(token, Match.OneOf(undefined, null, String)) &&
         ((userId && await globalDb.isAdminById(userId)) || tokenIsValid(token) ||
          await tokenIsSetupSessionAsync(token));
};

Meteor.publish("admin", async function (token) {
  if (!await authorizedAsAdmin(token, this.userId)) return [];

  // Admin is allowed to see all settings... but we redact the TLS key out of caution.
  return globalDb.collections.settings.find({ _id: { $ne: "tlsKeys" } });
});

Meteor.publish("adminServiceConfiguration", async function (token) {
  if (!await authorizedAsAdmin(token, this.userId)) return [];
  return ServiceConfiguration.configurations.find();
});

Meteor.publish("publicAdminSettings", function () {
  return globalDb.collections.settings.find({ _id: { $in: publicAdminSettings } });
});

Meteor.publish("adminToken", async function (token) {
  check(token, String);
  this.added("adminToken", "adminToken", {
    tokenIsValid: tokenIsValid(token) || await tokenIsSetupSessionAsync(token),
  });
  this.ready();
});

Meteor.publish("allUsers", async function (token) {
  if (!await authorizedAsAdmin(token, this.userId)) return [];
  return Meteor.users.find();
});

Meteor.publish("adminUserDetails", async function (userId) {
  if (!await authorizedAsAdmin(undefined, this.userId)) return [];

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
    Promise.resolve(observeHandle).then((h) => {
      if (typeof h === "function") { h(); } else if (h && typeof h.stop === "function") h.stop();
    }).catch((err) => {
      console.error("Failed to stop credential observer:", err);
    });
    this.removed("users", credentialId);
  };

  const refCredential = async (credentialId) => {
    if (credentialSubs[credentialId]) {
      // should never happen, but if somehow an account wound up with a duplicate credential ID,
      // avoid leaking a subscription
      console.error("duplicate credential id:", credentialId);
      return;
    }

    const cursor = Meteor.users.find({ _id: credentialId });
    const observeHandle = await cursor.observeAsync({
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
  const accountSubHandle = await accountCursor.observeAsync({
    added: (newDoc) => {
      const newCredentials = SandstormDb.getUserCredentialIds(newDoc);
      newCredentials.forEach((credentialId) => {
        refCredential(credentialId).catch((err) => {
          console.error("Failed to start credential observer (account added):", err);
        });
      });

      this.added("users", newDoc._id, newDoc);
    },

    changed: (newDoc, oldDoc) => {
      const newCredentials = SandstormDb.getUserCredentialIds(newDoc);
      const oldCredentials = SandstormDb.getUserCredentialIds(oldDoc);

      // Those in newDoc - oldDoc, ref.
      const credentialsAdded = difference(newCredentials, oldCredentials);
      credentialsAdded.forEach((credentialId) => {
        refCredential(credentialId).catch((err) => {
          console.error("Failed to start credential observer (account changed):", err);
        });
      });

      // Those in oldDoc - newDoc, unref.
      const credentialsRemoved = difference(oldCredentials, newCredentials);
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
    Promise.resolve(accountSubHandle).then((h) => {
      if (typeof h === "function") { h(); } else if (h && typeof h.stop === "function") h.stop();
    }).catch((err) => {
      console.error("Failed to stop account observer:", err);
    });
    // Also stop all the credential subscriptions.
    const subs = Object.values(credentialSubs);
    subs.forEach((sub) => {
      Promise.resolve(sub).then((h) => {
        if (typeof h === "function") { h(); } else if (h && typeof h.stop === "function") h.stop();
      }).catch((err) => {
        console.error("Failed to stop credential subscription:", err);
      });
    });
  });

  // `observeAsync()` resolves after initial observer setup, so by the time we get here
  // initial rows are published and we can report readiness.
  this.ready();
});

Meteor.publish("activityStats", async function (token) {
  if (!await authorizedAsAdmin(token, this.userId)) return [];
  return globalDb.collections.activityStats.find();
});

Meteor.publish("statsTokens", async function (token) {
  if (!await authorizedAsAdmin(token, this.userId)) return [];
  return globalDb.collections.statsTokens.find();
});

Meteor.publish("allPackages", async function (token) {
  if (!await authorizedAsAdmin(token, this.userId)) return [];
  return globalDb.collections.packages.find({ manifest: { $exists: true } },
      { fields: { appId: 1, "manifest.appVersion": 1,
      "manifest.actions": 1, "manifest.appTitle": 1, progress: 1, status: 1, }, });
});

Meteor.publish("realTimeStats", async function (token) {
  if (!await authorizedAsAdmin(token, this.userId)) return [];

  // Last five minutes.
  this.added("realTimeStats", "now", await computeStats(new Date(Date.now() - 5 * 60 * 1000)));

  // Since last sample.
  const lastSample = await globalDb.collections.activityStats
      .findOneAsync({}, { sort: { timestamp: -1 } });
  const lastSampleTime = lastSample ? lastSample.timestamp : new Date(0);
  this.added("realTimeStats", "today", await computeStats(lastSampleTime));

  // TODO(someday): Update every few minutes?

  this.ready();
});

Meteor.publish("adminLog", async function (token) {
  if (!await authorizedAsAdmin(token, this.userId)) return [];

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

Meteor.publish("adminApiTokens", async function (token) {
  if (!await authorizedAsAdmin(token, this.userId)) return [];
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

Meteor.publish("hasAdmin", async function (token) {
  // Like hasUsers, but for admins, and with token auth required.
  if (!await authorizedAsAdmin(token, this.userId)) return [];

  // Query if there are any admin users.
  const cursor = Meteor.users.find({ isAdmin: true });
  if (await cursor.countAsync() > 0) {
    this.added("hasAdmin", "hasAdmin", { hasAdmin: true });
  } else {
    let handle = await cursor.observeChangesAsync({
      added: (id) => {
        this.added("hasAdmin", "hasAdmin", { hasAdmin: true });
        Promise.resolve(handle).then((h) => {
          if (typeof h === "function") { h(); } else if (h && typeof h.stop === "function") h.stop();
        }).catch((err) => {
          console.error("Failed to stop hasAdmin observer after add:", err);
        });
        handle = null;
      },
    });
    this.onStop(function () {
      if (handle) {
        Promise.resolve(handle).then((h) => {
          if (typeof h === "function") { h(); } else if (h && typeof h.stop === "function") h.stop();
        }).catch((err) => {
          console.error("Failed to stop hasAdmin observer onStop:", err);
        });
      }
    });
  }

  this.ready();
});

Meteor.publish("appIndexAdmin", async function (token) {
  if (!await authorizedAsAdmin(token, this.userId)) return [];
  return globalDb.collections.appIndex.find();
});

function observeOauthService(name) {
  globalDb.collections.settings.find({ _id: name, value: true }).observeAsync({
    added: function () {
      // Tell the oauth library it should accept login attempts from this service.
      Accounts.oauth.registerService(name);
    },

    removed: function () {
      // Tell the oauth library it should deny login attempts from this service.
      Accounts.oauth.unregisterService(name);
    },
  }).catch((err) => {
    console.error(`Failed to observe OAuth service ${name}:`, err);
  });
}

observeOauthService("github");
observeOauthService("google");
