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
import { Accounts } from "meteor/accounts-base";
import { Random } from "meteor/random";
import { SHA256 } from "meteor/sha";
import { globalDb } from "/imports/db-deprecated";
import { checkAuthAsync, clearAdminToken } from "/imports/server/auth";
import { LDAP } from "/imports/server/accounts/ldap";
import { runDueJobs } from "/imports/server/scheduled-job";
import { SandstormAutoupdateApps } from "/imports/sandstorm-autoupdate-apps/autoupdate-apps";
import { isTesting } from "/imports/shared/testing";
import Crypto from "crypto";

async function clearUser(id) {
  await globalDb.collections.userActions.removeAsync({ userId: id });
  await globalDb.removeApiTokens({ userId: id });
  const grains = await globalDb.collections.grains.find({ userId: id }).fetchAsync();
  for (const grain of grains) {
    await globalThis.globalBackend.deleteGrain(grain._id);
  }

  await globalDb.collections.grains.removeAsync({ userId: id });
  await Meteor.users.removeAsync({ _id: id });
}

if(isTesting) {
  Meteor.methods({
    async runDueJobsAt(whenMillis) {
      await runDueJobs(new Date(whenMillis));
    },

    createMockGithubUser: async function () {
      await Meteor.users.updateAsync({ _id: "Py8fwsaryQNGBuiXb" },
                          { $set: { createdAt: new Date("2014-08-11T21:44:04.147Z"), isAdmin: true, lastActive: new Date("2014-08-19T09:58:39.676Z"), profile: { name: "Github User" }, services: { github: { accessToken: "sometoken", id: 1595880, username: "testuser" }, resume: { loginTokens: [{ when: new Date("2099-08-13T05:16:02.356Z"),     hashedToken: "GriUSDp+uN/K4HptwSl1wsdWfHEpS8c9KjjdqwKNo0k=" }] } }, signupKey: "admin" } },
                          { upsert: true });
    },

    clearMockGithubUser: async function () {
      await clearUser("Py8fwsaryQNGBuiXb");
    },

    createMockGoogleUser: async function () {
      await Meteor.users.updateAsync({ _id: "6WJcRo2gg2Ysuxsok" },
                          { $set: { createdAt: new Date("2014-08-21T07:52:55.581Z"), profile: { name: "Google User" }, services: { google: { accessToken: "sometoken", expiresAt: 4562182723000, id: "116893057283177439912", verified_email: true, name: "Google User", given_name: "Google", family_name: "User", picture: "https://lh3.googleusercontent.com/-XdUIqdMkCWA/AAAAAAAAAAI/AAAAAAAAAAA/4252rscbv5M/photo.jpg", locale: "en", gender: "male" }, resume: { loginTokens: [{ when: new Date("2099-08-21T07:52:55.592Z"),   hashedToken: "cbJGxLGKW3f0j7Ehit77hdK58W7xuPjzZhGHgKhyddo=" }] } }, signupKey: "admin" } },
                         { upsert: true });
    },

    clearMockGoogleUser: async function () {
      await clearUser("6WJcRo2gg2Ysuxsok");
    },

    fetchAppIndexTest: async function () {
      await globalDb.collections.appIndex.removeAsync({});
      await SandstormAutoupdateApps.updateAppIndex(this.connection.sandstormDb);
    },

    testRegressionSetupSessionClear: async function () {
      const token = "test-setup-session-" + Random.secret();
      const hashedSessionId = Crypto.createHash("sha256").update(token).digest("base64");

      await globalDb.collections.setupSession.upsertAsync({ _id: "current-session" }, {
        _id: "current-session",
        hashedSessionId,
        creationDate: new Date(),
      });

      await checkAuthAsync(globalDb, null, token);

      const adminPublish = Meteor.server.publish_handlers.admin;
      if (!adminPublish) {
        throw new Meteor.Error("missing-admin-publication", "admin publication not registered.");
      }

      const adminCursor = await adminPublish.apply({
        userId: null,
        ready() {},
        onStop() {},
      }, [token]);
      if (!adminCursor || typeof adminCursor.fetchAsync !== "function") {
        throw new Meteor.Error("setup-session-publication-denied",
            "Fresh setup session token did not authorize admin publication.");
      }

      await clearAdminToken(token);

      const remaining = await globalDb.collections.setupSession.findOneAsync({
        _id: "current-session",
        hashedSessionId,
      });
      if (remaining) {
        throw new Meteor.Error("setup-session-not-cleared", "Setup session was not removed.");
      }

      try {
        await checkAuthAsync(globalDb, null, token);
      } catch (err) {
        if (err && err.error === 403) return true;
        throw err;
      }

      throw new Meteor.Error("setup-session-still-valid", "Setup session token still authorized.");
    },

    testRegressionLdapQuotaReturnValue: async function () {
      const userId = "test-ldap-account-" + Random.id();
      const credentialId = "test-ldap-credential-" + Random.id();
      const previousSetting = await globalDb.collections.settings.findOneAsync({ _id: "quotaLdapAttribute" });

      await Meteor.users.insertAsync({
        _id: userId,
        type: "account",
        loginCredentials: [{ id: credentialId }],
        nonloginCredentials: [],
        profile: { name: "LDAP quota test" },
        cachedStorageQuota: 100,
      });

      await Meteor.users.insertAsync({
        _id: credentialId,
        type: "credential",
        profile: { name: "LDAP quota test credential" },
        services: { email: { email: "ldap-quota-test@example.com" } },
      });

      try {
        await globalDb.collections.settings.upsertAsync({ _id: "quotaLdapAttribute" }, {
          _id: "quotaLdapAttribute",
          value: "quotaBytes",
        });

        const ldap = new LDAP();
        ldap.ldapCheck = async function () {
          return { searchResults: { quotaBytes: "123456" } };
        };

        const user = await Meteor.users.findOneAsync({ _id: userId });
        const quota = await ldap.updateUserQuota(globalDb, user);
        if (!quota || quota.storage !== 123456) {
          throw new Meteor.Error("ldap-quota-not-returned",
              "LDAP quota lookup returned " + JSON.stringify(quota));
        }

        const updatedUser = await Meteor.users.findOneAsync({ _id: userId });
        if (!updatedUser || updatedUser.cachedStorageQuota !== 123456) {
          throw new Meteor.Error("ldap-quota-not-cached", "LDAP quota was not cached on the user.");
        }

        return true;
      } finally {
        await Meteor.users.removeAsync({ _id: { $in: [userId, credentialId] } });
        if (previousSetting) {
          await globalDb.collections.settings.upsertAsync({ _id: "quotaLdapAttribute" }, previousSetting);
        } else {
          await globalDb.collections.settings.removeAsync({ _id: "quotaLdapAttribute" });
        }
      }
    },

    testRegressionEmailCredentialLinkAwaitsFailure: async function () {
      const accountId = "test-email-link-account-" + Random.id();
      const credentialId = "test-email-link-credential-" + Random.id();
      const email = "email-link-test-" + Random.id() + "@example.com";
      const token = "email-link-token-" + Random.secret();
      const originalLinkCredentialToAccount = Accounts.linkCredentialToAccount;

      await Meteor.users.insertAsync({
        _id: accountId,
        type: "account",
        loginCredentials: [{ id: "test-login-credential-" + Random.id() }],
        nonloginCredentials: [],
        profile: { name: "Email link test account" },
      });

      await Meteor.users.insertAsync({
        _id: credentialId,
        type: "credential",
        profile: { name: "Email link test credential" },
        services: {
          email: {
            email,
            tokens: [{ digest: SHA256(token), algorithm: "sha-256" }],
          },
        },
      });

      try {
        Accounts.linkCredentialToAccount = async function () {
          await new Promise((resolve) => Meteor.setTimeout(resolve, 25));
          throw new Meteor.Error("test-link-failed", "Synthetic link failure.");
        };

        const handler = Meteor.server.method_handlers.linkEmailCredentialToAccount;
        if (!handler) {
          throw new Meteor.Error("missing-method", "linkEmailCredentialToAccount method not registered.");
        }

        try {
          await handler.apply({
            userId: accountId,
            connection: {
              sandstormDb: globalDb,
              sandstormBackend: globalThis.globalBackend,
            },
          }, [email, token, false]);
        } catch (err) {
          if (err && err.error === "test-link-failed") return true;
          throw err;
        }

        throw new Meteor.Error("email-link-did-not-await",
            "linkEmailCredentialToAccount returned before Accounts.linkCredentialToAccount settled.");
      } finally {
        Accounts.linkCredentialToAccount = originalLinkCredentialToAccount;
        await Meteor.users.removeAsync({ _id: { $in: [accountId, credentialId] } });
      }
    },
  });
}
