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

/* global MailchimpSubscribers */

import { Meteor } from "meteor/meteor";
import { Accounts } from "meteor/accounts-base";
import { HTTP } from "meteor/http";
import { Random } from "meteor/random";
import { SHA256 } from "meteor/sha";
import { ServiceConfiguration } from "meteor/service-configuration";
import { globalDb } from "/imports/db-deprecated";
import { httpCallAsync } from "/imports/http-helpers";
import { checkAuthAsync, clearAdminToken } from "/imports/server/auth";
import { setAccountSuspensionEmailSenderForTests } from "/imports/server/account-suspension";
import { setAdminEmailSenderForTests } from "/imports/server/admin-server";
import {
  handleWebhookEvent,
  setPaymentsHttpCallForTests,
  stripe as testStripe,
  updateMailchimp,
} from "/imports/blackrock-payments/server/payments-server";
import { MAILING_LIST_BONUS } from "/imports/blackrock-payments/constants";
import { LDAP } from "/imports/server/accounts/ldap";
import { validateSandstormLoginAttempt } from "/imports/server/accounts/accounts-server";
import {
  emailTokenLoginHandler,
  setTokenEmailSenderForTests,
} from "/imports/server/accounts/email-token/token-server";
import { reconcileOidcUsersIndex } from "/imports/server/migrations";
import { runDueJobs } from "/imports/server/scheduled-job";
import {
  Downloader,
  setTransferCreateGrainBackupForTests,
  setTransferDownloaderDisabledForTests,
  setTransferDownloaderHooksForTests,
  setTransferHttpCallForTests,
} from "/imports/server/transfers-server";
import { SandstormAutoupdateApps } from "/imports/sandstorm-autoupdate-apps/autoupdate-apps";
import { isTesting } from "/imports/shared/testing";
import Crypto from "crypto";
import { EventEmitter } from "events";

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

function getMethodHandler(name) {
  const handlers = Meteor.server && (Meteor.server.method_handlers || Meteor.server.methodHandlers);
  if (!handlers || !handlers[name]) {
    throw new Meteor.Error("missing-method", name + " method not registered.");
  }

  return handlers[name];
}

function getPublishHandler(name) {
  const handlers = Meteor.server && (Meteor.server.publish_handlers || Meteor.server.publishHandlers);
  if (!handlers || !handlers[name]) {
    throw new Meteor.Error("missing-publication", name + " publication not registered.");
  }

  return handlers[name];
}

function makeFakeSubscription(userId) {
  const stopCallbacks = [];
  const sub = {
    userId,
    addedDocs: {},
    changedDocs: {},
    removedDocs: {},
    readyCalled: false,
    errors: [],

    added(collection, id, fields) {
      if (!this.addedDocs[collection]) this.addedDocs[collection] = {};
      this.addedDocs[collection][id] = fields;
    },

    changed(collection, id, fields) {
      if (!this.changedDocs[collection]) this.changedDocs[collection] = {};
      this.changedDocs[collection][id] = fields;
    },

    removed(collection, id) {
      if (!this.removedDocs[collection]) this.removedDocs[collection] = {};
      this.removedDocs[collection][id] = true;
    },

    ready() {
      this.readyCalled = true;
    },

    error(err) {
      this.errors.push(err);
    },

    onStop(callback) {
      stopCallbacks.push(callback);
    },

    stop() {
      stopCallbacks.forEach((callback) => callback());
    },
  };

  return sub;
}

function makeTestTokenRecord(token) {
  return {
    digest: SHA256(token),
    algorithm: "sha-256",
    createdAt: new Date(),
  };
}

function makeOidcIndexTestDb(indexes, duplicates) {
  const calls = [];
  const rawCollection = {
    async indexes() {
      calls.push(["indexes"]);
      return indexes;
    },

    async createIndex(key, options) {
      calls.push(["createIndex", key, options]);
    },

    async dropIndex(name) {
      calls.push(["dropIndex", name]);
    },

    aggregate(pipeline) {
      calls.push(["aggregate", pipeline]);
      return {
        async toArray() {
          calls.push(["toArray"]);
          return duplicates || [];
        },
      };
    },
  };

  return {
    calls,
    db: {
      collections: {
        users: {
          rawCollection() {
            calls.push(["rawCollection"]);
            return rawCollection;
          },
        },
      },
    },
  };
}

function hasCall(calls, predicate) {
  return calls.some(predicate);
}

function getLastLine(text) {
  return text.trim().split("\n").pop();
}

function makeTransferResponse(statusCode) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.destroyed = false;
  response.destroy = function () {
    response.destroyed = true;
  };
  return response;
}

function makeTransferRequest(statusOrError, onEnd) {
  const request = new EventEmitter();
  request.ended = false;
  request.destroyed = false;
  request.end = function () {
    request.ended = true;
    if (onEnd) onEnd(request);
    Meteor.setTimeout(() => {
      if (statusOrError instanceof Error) {
        request.emit("error", statusOrError);
      } else {
        request.emit("response", makeTransferResponse(statusOrError));
      }
    }, 0);
  };
  request.destroy = function () {
    request.destroyed = true;
    request.emit("error", new Error("Request canceled."));
  };
  return request;
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

        const handler = getMethodHandler("linkEmailCredentialToAccount");

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

    testRegressionOidcSigninAndIndexMigration: async function () {
      const configurations = ServiceConfiguration.configurations;
      const indexName = "services.oidc.id_1";
      const desiredKey = { "services.oidc.id": 1 };

      await configurations.removeAsync({ service: "oidc" });

      try {
        await configurations.insertAsync({
          service: "oidc",
          issuer: {
            issuer: "https://idp.example",
            authorization_endpoint: "https://idp.example/authorize",
            token_endpoint: "https://idp.example/token",
            userinfo_endpoint: "https://idp.example/userinfo",
            jwks_uri: "https://idp.example/jwks",
          },
          clientId: "sandstorm-client",
          secret: "test-secret",
          requestPermissions: ["openid", "email", "profile", "groups"],
        });

        const url = await getMethodHandler("resolveOidcSigninUrl").apply({
          userId: null,
          connection: {},
        }, ["state-token"]);
        const parsed = new URL(url);
        if (parsed.origin + parsed.pathname !== "https://idp.example/authorize") {
          throw new Meteor.Error("oidc-authorize-url", "Unexpected authorization URL: " + url);
        }

        if (parsed.searchParams.get("client_id") !== "sandstorm-client") {
          throw new Meteor.Error("oidc-client-id", "OIDC signin URL omitted client id.");
        }

        if (parsed.searchParams.get("state") !== "state-token") {
          throw new Meteor.Error("oidc-state", "OIDC signin URL omitted state.");
        }

        if (parsed.searchParams.get("scope") !== "openid email profile groups") {
          throw new Meteor.Error("oidc-scopes", "OIDC signin URL omitted requested scopes.");
        }

        if (!/\/_oauth\/oidc$/.test(parsed.searchParams.get("redirect_uri") || "")) {
          throw new Meteor.Error("oidc-redirect-uri", "OIDC signin URL omitted redirect URI.");
        }

        await configurations.removeAsync({ service: "oidc" });
        try {
          await getMethodHandler("resolveOidcSigninUrl").apply({
            userId: null,
            connection: {},
          }, ["state-token"]);
          throw new Meteor.Error("oidc-missing-config-accepted",
              "resolveOidcSigninUrl accepted missing OIDC configuration.");
        } catch (err) {
          if (!/Service oidc not configured/i.test(err.message || "")) throw err;
        }

        let testDb = makeOidcIndexTestDb([{ name: "_id_", key: { _id: 1 } }]);
        await reconcileOidcUsersIndex(testDb.db, null);
        if (!hasCall(testDb.calls, (call) =>
          call[0] === "createIndex" &&
          call[1]["services.oidc.id"] === 1 &&
          call[2].name === indexName &&
          call[2].unique === true &&
          call[2].sparse === true)) {
          throw new Meteor.Error("oidc-index-not-created", "Missing OIDC index was not created.");
        }

        testDb = makeOidcIndexTestDb([
          { name: indexName, key: desiredKey, unique: true, sparse: true },
        ]);
        await reconcileOidcUsersIndex(testDb.db, null);
        if (hasCall(testDb.calls, (call) => call[0] === "dropIndex" || call[0] === "createIndex")) {
          throw new Meteor.Error("oidc-index-recreated", "Correct OIDC index was changed.");
        }

        testDb = makeOidcIndexTestDb([
          { name: indexName, key: desiredKey, sparse: true },
        ], []);
        await reconcileOidcUsersIndex(testDb.db, null);
        if (!hasCall(testDb.calls, (call) => call[0] === "dropIndex" && call[1] === indexName) ||
            !hasCall(testDb.calls, (call) => call[0] === "createIndex")) {
          throw new Meteor.Error("oidc-index-not-replaced", "Non-unique OIDC index was not replaced.");
        }

        testDb = makeOidcIndexTestDb([
          { name: indexName, key: desiredKey, sparse: true },
        ], [{ _id: "duplicate-id", count: 2 }]);
        try {
          await reconcileOidcUsersIndex(testDb.db, null);
          throw new Meteor.Error("oidc-duplicates-accepted",
              "Duplicate OIDC IDs did not stop index migration.");
        } catch (err) {
          if (!/duplicate OIDC IDs/i.test(err.message || "")) throw err;
        }

        if (hasCall(testDb.calls, (call) => call[0] === "dropIndex" || call[0] === "createIndex")) {
          throw new Meteor.Error("oidc-duplicate-index-changed",
              "OIDC index changed despite duplicate OIDC IDs.");
        }

        return true;
      } finally {
        await configurations.removeAsync({ service: "oidc" });
      }
    },

    testRegressionEmailTokenCreationAndLogin: async function () {
      const settingIds = ["emailToken", "serverTitle", "smtpConfig"];
      const sentEmails = [];
      const clearState = async () => {
        await Meteor.users.removeAsync({ "services.email.email": /^email-token-test-/ });
        await globalDb.collections.standaloneDomains.removeAsync({ _id: /^email-token-test-/ });
        await globalDb.collections.settings.removeAsync({ _id: { $in: settingIds } });
      };
      const configure = async () => {
        await globalDb.collections.settings.upsertAsync({ _id: "emailToken" }, { $set: { value: true } });
        await globalDb.collections.settings.upsertAsync({ _id: "serverTitle" },
            { $set: { value: "Test Sandstorm" } });
        await globalDb.collections.settings.upsertAsync({ _id: "smtpConfig" }, {
          $set: {
            value: {
              hostname: "smtp.example",
              port: 25,
              returnAddress: "no-reply@example.com",
            },
          },
        });
      };
      const callCreateToken = async (email, options) => {
        return await getMethodHandler("createAndEmailTokenForUser").apply({
          userId: null,
          connection: {
            sandstormDb: globalDb,
            sandstormBackend: globalThis.globalBackend,
          },
        }, [email, options]);
      };
      const optionsFor = (rootUrl) => ({
        resumePath: "/grain/test",
        rootUrl,
      });

      await clearState();
      await configure();
      setTokenEmailSenderForTests(async function (message) {
        await new Promise((resolve) => Meteor.setTimeout(resolve, 5));
        sentEmails.push(message);
      });

      try {
        try {
          await callCreateToken("email-token-test-invalid@example.com", optionsFor("https://attacker.example"));
          throw new Meteor.Error("email-token-invalid-root-accepted",
              "Invalid email-token rootUrl was accepted.");
        } catch (err) {
          if (err.error !== 400 || !/rootUrl is not valid/i.test(err.message || "")) throw err;
        }

        if (sentEmails.length !== 0) {
          throw new Meteor.Error("email-token-invalid-root-sent",
              "Invalid email-token rootUrl sent email.");
        }

        const standaloneHost = "email-token-test-standalone.example";
        const standaloneEmail = "email-token-test-standalone@example.com";
        await globalDb.collections.standaloneDomains.insertAsync({ _id: standaloneHost });
        await callCreateToken(standaloneEmail, optionsFor("http://" + standaloneHost));
        if (sentEmails.length !== 1) {
          throw new Meteor.Error("email-token-email-not-sent", "Email token send was not awaited.");
        }

        const firstEmail = sentEmails[0];
        if (firstEmail.to !== standaloneEmail ||
            firstEmail.from.name !== "Test Sandstorm" ||
            firstEmail.from.address !== "no-reply@example.com" ||
            !firstEmail.text.includes("http://" + standaloneHost + "/_emailLogin/") ||
            !getLastLine(firstEmail.text)) {
          throw new Meteor.Error("email-token-email-content",
              "Email token message did not include expected async title/address/link/token.");
        }

        const standaloneUser = await Meteor.users.findOneAsync({ "services.email.email": standaloneEmail });
        if (!standaloneUser || standaloneUser.services.email.tokens.length !== 1) {
          throw new Meteor.Error("email-token-standalone-user",
              "Standalone email token did not create a token-bearing credential.");
        }

        const existingEmail = "email-token-test-existing@example.com";
        const existingUserId = "test-email-token-user-" + Random.id();
        await Meteor.users.insertAsync({
          _id: existingUserId,
          services: {
            email: {
              email: existingEmail,
              tokens: [],
            },
          },
        });
        await callCreateToken(existingEmail, optionsFor(Meteor.absoluteUrl()));
        const existingUser = await Meteor.users.findOneAsync(existingUserId);
        if (existingUser.services.email.tokens.length !== 1) {
          throw new Meteor.Error("email-token-not-appended", "Email token was not appended.");
        }

        const rateLimitEmail = "email-token-test-rate-limit@example.com";
        await Meteor.users.insertAsync({
          _id: "test-email-token-user-" + Random.id(),
          services: {
            email: {
              email: rateLimitEmail,
              tokens: [
                makeTestTokenRecord("one"),
                makeTestTokenRecord("two"),
                makeTestTokenRecord("three"),
              ],
            },
          },
        });
        const sentBeforeRateLimit = sentEmails.length;
        try {
          await callCreateToken(rateLimitEmail, optionsFor(Meteor.absoluteUrl()));
          throw new Meteor.Error("email-token-rate-limit-accepted",
              "Too many active email tokens were accepted.");
        } catch (err) {
          if (err.error !== "alreadySentEmailToken") throw err;
        }

        if (sentEmails.length !== sentBeforeRateLimit) {
          throw new Meteor.Error("email-token-rate-limit-sent",
              "Rate-limited email token request sent email.");
        }

        const loginEmail = "email-token-test-login@example.com";
        const loginToken = "valid-token";
        const loginUserId = "test-email-token-user-" + Random.id();
        await Meteor.users.insertAsync({
          _id: loginUserId,
          services: {
            email: {
              email: loginEmail,
              tokens: [makeTestTokenRecord(loginToken)],
            },
          },
        });

        const loginResult = await emailTokenLoginHandler({
          email: {
            email: loginEmail,
            token: " " + loginToken + " ",
          },
        });
        if (!loginResult || loginResult.userId !== loginUserId) {
          throw new Meteor.Error("email-token-login-user",
              "Valid email token did not return the expected user id.");
        }

        const consumedUser = await Meteor.users.findOneAsync(loginUserId);
        if ((consumedUser.services.email.tokens || []).length !== 0) {
          throw new Meteor.Error("email-token-not-consumed", "Valid email token was not consumed.");
        }

        const invalidLoginEmail = "email-token-test-invalid-login@example.com";
        const invalidLoginUserId = "test-email-token-user-" + Random.id();
        await Meteor.users.insertAsync({
          _id: invalidLoginUserId,
          services: {
            email: {
              email: invalidLoginEmail,
              tokens: [makeTestTokenRecord("still-valid")],
            },
          },
        });

        const invalidLoginResult = await emailTokenLoginHandler({
          email: {
            email: invalidLoginEmail,
            token: "wrong-token",
          },
        });
        if (!invalidLoginResult.error ||
            invalidLoginResult.error.error !== 403 ||
            !/Invalid authentication code/i.test(invalidLoginResult.error.message || "")) {
          throw new Meteor.Error("email-token-invalid-login",
              "Invalid email token did not return the expected login error.");
        }

        const invalidLoginUser = await Meteor.users.findOneAsync(invalidLoginUserId);
        if (invalidLoginUser.services.email.tokens.length !== 1) {
          throw new Meteor.Error("email-token-invalid-consumed",
              "Invalid email token consumed an active token.");
        }

        return true;
      } finally {
        setTokenEmailSenderForTests(null);
        await clearState();
      }
    },

    testRegressionAccountSuspensionAndDeletion: async function () {
      const adminId = "test-suspension-admin-" + Random.id();
      const adminCredentialId = "test-suspension-admin-credential-" + Random.id();
      const targetId = "test-suspension-target-" + Random.id();
      const targetCredentialId = "test-suspension-target-credential-" + Random.id();
      const selfDeleteId = "test-suspension-self-delete-" + Random.id();
      const selfDeleteCredentialId = "test-suspension-self-delete-credential-" + Random.id();
      const orgUserId = "test-suspension-org-user-" + Random.id();
      const orgCredentialId = "test-suspension-org-credential-" + Random.id();
      const eligibleDeleteId = "test-suspension-eligible-delete-" + Random.id();
      const eligibleDeleteCredentialId = "test-suspension-eligible-credential-" + Random.id();
      const recentDeleteId = "test-suspension-recent-delete-" + Random.id();
      const recentDeleteCredentialId = "test-suspension-recent-credential-" + Random.id();
      const grainId = "testSuspensionGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, "");
      const apiTokenId = "test-suspension-token-" + Random.id();
      const sentEmails = [];
      const suspendedPaymentUsers = [];
      const backendDeletedUsers = [];
      const callbackDeletedUsers = [];
      const oldStripePublicKey = Meteor.settings.public.stripePublicKey;
      const oldPaymentsSuspend = globalThis.BlackrockPayments.suspendAccount;

      const insertAccountWithCredential = async (accountId, credentialId, email, fields) => {
        await Meteor.users.insertAsync({
          _id: credentialId,
          type: "credential",
          services: {
            email: { email },
            resume: { loginTokens: [{ token: credentialId + "-token" }] },
          },
          profile: { name: "Suspension test credential" },
        });
        await Meteor.users.insertAsync({
          _id: accountId,
          type: "account",
          signupKey: "admin",
          loginCredentials: [{ id: credentialId }],
          nonloginCredentials: [],
          primaryEmail: email,
          services: { resume: { loginTokens: [{ token: accountId + "-token" }] } },
          profile: { name: "Suspension test account" },
          ...fields,
        });
      };
      const callSuspensionMethod = async (name, userId, args) => {
        return await getMethodHandler(name).apply({
          userId,
          connection: {
            sandstormDb: globalDb,
            sandstormBackend: globalThis.globalBackend,
          },
        }, args);
      };
      const hasResumeLoginTokens = (user) =>
        !!(user.services && user.services.resume && user.services.resume.loginTokens);

      setAccountSuspensionEmailSenderForTests(async function (message) {
        sentEmails.push({ ...message });
      });
      Meteor.settings.public.stripePublicKey = "pk_test_enabled";
      globalThis.BlackrockPayments.suspendAccount = async function (_db, userId) {
        suspendedPaymentUsers.push(userId);
      };

      await globalDb.collections.settings.upsertAsync({ _id: "serverTitle" }, {
        $set: { value: "Suspension Test Server" },
      });
      await globalDb.collections.settings.upsertAsync({ _id: "smtpConfig" }, {
        $set: {
          value: {
            hostname: "smtp.example",
            port: 25,
            returnAddress: "no-reply@example.com",
          },
        },
      });
      await insertAccountWithCredential(adminId, adminCredentialId, "suspension-admin@example.com", {
        isAdmin: true,
        profile: { name: "Suspension Admin" },
      });
      await insertAccountWithCredential(targetId, targetCredentialId, "suspension-target@example.com", {});
      await insertAccountWithCredential(selfDeleteId, selfDeleteCredentialId,
          "suspension-self-delete@example.com", {});
      await insertAccountWithCredential(orgUserId, orgCredentialId, "org-user@example.com", {});
      await insertAccountWithCredential(eligibleDeleteId, eligibleDeleteCredentialId,
          "suspension-eligible-delete@example.com", {
            suspended: {
              willDelete: true,
              timestamp: new Date(Date.now() - 10000),
              voluntary: true,
            },
          });
      await insertAccountWithCredential(recentDeleteId, recentDeleteCredentialId,
          "suspension-recent-delete@example.com", {
            suspended: {
              willDelete: true,
              timestamp: new Date(),
              voluntary: true,
            },
          });
      await globalDb.collections.grains.insertAsync({
        _id: grainId,
        userId: targetId,
        appId: "suspension-app",
        packageId: "suspension-package",
        appVersion: 1,
        title: "Suspension grain",
      });
      await globalDb.collections.apiTokens.insertAsync({
        _id: apiTokenId,
        owner: { user: { accountId: targetId } },
        created: new Date(),
      });

      try {
        try {
          await callSuspensionMethod("suspendAccount", selfDeleteId, [targetId, false]);
          throw new Meteor.Error("suspension-non-admin-accepted",
              "suspendAccount accepted a non-admin caller.");
        } catch (err) {
          if (err.error !== 403) throw err;
        }

        await callSuspensionMethod("suspendAccount", adminId, [targetId, true]);
        let target = await Meteor.users.findOneAsync(targetId);
        let targetCredential = await Meteor.users.findOneAsync(targetCredentialId);
        const grain = await globalDb.collections.grains.findOneAsync(grainId);
        const apiToken = await globalDb.collections.apiTokens.findOneAsync(apiTokenId);
        const suspendFailures = [];
        if (!target.suspended) suspendFailures.push("account not suspended");
        if (target.suspended && target.suspended.willDelete !== true) suspendFailures.push("willDelete not set");
        if (target.suspended && target.suspended.admin !== adminId) suspendFailures.push("admin not recorded");
        if (hasResumeLoginTokens(target)) suspendFailures.push("account resume tokens not cleared");
        if (!targetCredential.suspended) suspendFailures.push("credential not suspended");
        if (hasResumeLoginTokens(targetCredential)) suspendFailures.push("credential resume tokens not cleared");
        if (!grain.suspended) suspendFailures.push("grain not suspended");
        if (!apiToken.suspended) suspendFailures.push("api token not suspended");
        if (!suspendedPaymentUsers.includes(targetId)) suspendFailures.push("payments suspension not called");
        if (suspendFailures.length > 0) {
          throw new Meteor.Error("suspension-admin-suspend",
              "suspendAccount did not suspend account, credential, grains, tokens, and payments: " +
              suspendFailures.join(", ") + ".");
        }

        if (!sentEmails.some((email) =>
          email.to === "suspension-admin@example.com" &&
          /Suspension Admin has requested/.test(email.text || "") &&
          /suspension-target@example.com/.test(email.text || ""))) {
          throw new Meteor.Error("suspension-admin-email",
              "suspendAccount(willDelete) did not send admin deletion email.");
        }

        await callSuspensionMethod("unsuspendAccount", adminId, [targetId]);
        target = await Meteor.users.findOneAsync(targetId);
        targetCredential = await Meteor.users.findOneAsync(targetCredentialId);
        const unsuspendedGrain = await globalDb.collections.grains.findOneAsync(grainId);
        const unsuspendedToken = await globalDb.collections.apiTokens.findOneAsync(apiTokenId);
        if (target.suspended || targetCredential.suspended ||
            unsuspendedGrain.suspended || unsuspendedToken.suspended) {
          throw new Meteor.Error("suspension-admin-unsuspend",
              "unsuspendAccount did not clear account, credential, grain, and token suspension.");
        }

        const emailsBeforeSelfDelete = sentEmails.length;
        await callSuspensionMethod("deleteOwnAccount", selfDeleteId, ["No longer needed."]);
        const selfDeleteUser = await Meteor.users.findOneAsync(selfDeleteId);
        if (!selfDeleteUser.suspended ||
            selfDeleteUser.suspended.willDelete !== true ||
            selfDeleteUser.suspended.voluntary !== true ||
            !suspendedPaymentUsers.includes(selfDeleteId)) {
          throw new Meteor.Error("suspension-delete-own",
              "deleteOwnAccount did not voluntarily suspend account for deletion.");
        }

        const selfDeleteEmails = sentEmails.slice(emailsBeforeSelfDelete);
        if (!selfDeleteEmails.some((email) => email.to === "suspension-self-delete@example.com") ||
            !selfDeleteEmails.some((email) =>
              email.to === "suspension-admin@example.com" &&
              /No longer needed/.test(email.text || ""))) {
          throw new Meteor.Error("suspension-delete-own-emails",
              "deleteOwnAccount did not send user/admin deletion emails.");
        }

        await globalDb.collections.settings.upsertAsync({ _id: "organizationMembership" }, {
          $set: {
            value: {
              emailToken: { enabled: true, domain: "example.com" },
              google: { enabled: false, domain: "" },
              ldap: { enabled: false },
              oidc: { enabled: false },
              saml: { enabled: false },
            },
          },
        });
        try {
          await callSuspensionMethod("deleteOwnAccount", orgUserId, [""]);
          throw new Meteor.Error("suspension-org-delete-accepted",
              "deleteOwnAccount accepted an organization user.");
        } catch (err) {
          if (err.error !== 403 || !/organization cannot delete/i.test(err.message || "")) throw err;
        }

        await globalDb.deletePendingAccounts(1000, {
          async deleteUser(userId) {
            backendDeletedUsers.push(userId);
          },
        }, function (_db, user) {
          callbackDeletedUsers.push(user._id);
        });
        if (await Meteor.users.findOneAsync(eligibleDeleteId) ||
            await Meteor.users.findOneAsync(eligibleDeleteCredentialId) ||
            !await Meteor.users.findOneAsync(recentDeleteId) ||
            !callbackDeletedUsers.includes(eligibleDeleteId) ||
            !backendDeletedUsers.includes(eligibleDeleteId)) {
          throw new Meteor.Error("suspension-pending-delete",
              "deletePendingAccounts did not delete only eligible accounts after cooling-off.");
        }

        return true;
      } finally {
        setAccountSuspensionEmailSenderForTests(null);
        Meteor.settings.public.stripePublicKey = oldStripePublicKey;
        globalThis.BlackrockPayments.suspendAccount = oldPaymentsSuspend;
        await globalDb.collections.settings.removeAsync({
          _id: { $in: ["serverTitle", "smtpConfig", "organizationMembership"] },
        });
        await globalDb.collections.grains.removeAsync(grainId);
        await globalDb.collections.apiTokens.removeAsync(apiTokenId);
        await Meteor.users.removeAsync({
          _id: {
            $in: [
              adminId,
              adminCredentialId,
              targetId,
              targetCredentialId,
              selfDeleteId,
              selfDeleteCredentialId,
              orgUserId,
              orgCredentialId,
              eligibleDeleteId,
              eligibleDeleteCredentialId,
              recentDeleteId,
              recentDeleteCredentialId,
            ],
          },
        });
      }
    },

    testRegressionOrganizationMembershipAndLoginValidation: async function () {
      const orgCredentialId = "test-org-credential-" + Random.id();
      const orgAccountNonOrgCredentialId = "test-org-account-non-credential-" + Random.id();
      const nonOrgCredentialId = "test-org-non-account-credential-" + Random.id();
      const orgAccountId = "test-org-account-" + Random.id();
      const nonOrgAccountId = "test-org-non-account-" + Random.id();

      await globalDb.collections.settings.upsertAsync({ _id: "organizationMembership" }, {
        $set: {
          value: {
            emailToken: { enabled: true, domain: "*.example.com,example.org" },
            google: { enabled: true, domain: "example.com" },
            ldap: { enabled: true },
            oidc: { enabled: true },
            saml: { enabled: true },
          },
        },
      });
      await globalDb.collections.settings.upsertAsync({ _id: "organizationSettings" }, {
        $set: {
          value: {
            disallowGuests: true,
            shareContacts: false,
          },
        },
      });

      try {
        const cases = [
          [{ services: { email: { email: "user@dept.example.com" } } }, true, "email wildcard"],
          [{ services: { email: { email: "user@example.org" } } }, true, "email exact"],
          [{ services: { email: { email: "user@outside.test" } } }, false, "email outside"],
          [{ services: { google: { hd: "example.com" } } }, true, "google hosted domain"],
          [{ services: { google: { hd: "outside.test" } } }, false, "google outside"],
          [{ services: { ldap: { id: "ldap-user" } } }, true, "ldap"],
          [{ services: { oidc: { id: "oidc-user" } } }, true, "oidc"],
          [{ services: { saml: { id: "saml-user" } } }, true, "saml"],
        ];

        for (const [credential, expected, label] of cases) {
          const actual = await globalDb.isCredentialInOrganizationAsync(credential);
          if (actual !== expected) {
            throw new Meteor.Error("org-credential-" + label.replace(/[^a-z0-9]+/gi, "-"),
                "Unexpected organization membership for " + label + ": " + actual);
          }
        }

        await Meteor.users.insertAsync({
          _id: orgCredentialId,
          type: "credential",
          services: { email: { email: "member@dept.example.com" } },
        });
        await Meteor.users.insertAsync({
          _id: orgAccountNonOrgCredentialId,
          type: "credential",
          services: { email: { email: "outsider@outside.test" } },
        });
        await Meteor.users.insertAsync({
          _id: nonOrgCredentialId,
          type: "credential",
          services: { email: { email: "other-outsider@outside.test" } },
        });
        await Meteor.users.insertAsync({
          _id: orgAccountId,
          type: "account",
          loginCredentials: [{ id: orgAccountNonOrgCredentialId }, { id: orgCredentialId }],
          nonloginCredentials: [],
          profile: { name: "Org account" },
        });
        await Meteor.users.insertAsync({
          _id: nonOrgAccountId,
          type: "account",
          loginCredentials: [{ id: nonOrgCredentialId }],
          nonloginCredentials: [],
          profile: { name: "Non-org account" },
        });

        const orgAccount = await Meteor.users.findOneAsync(orgAccountId);
        const nonOrgAccount = await Meteor.users.findOneAsync(nonOrgAccountId);
        if (!await globalDb.isUserInOrganizationAsync(orgAccount)) {
          throw new Meteor.Error("org-user-membership",
              "isUserInOrganizationAsync did not accept account with one organization credential.");
        }

        if (await globalDb.isUserInOrganizationAsync(nonOrgAccount)) {
          throw new Meteor.Error("org-user-non-member",
              "isUserInOrganizationAsync accepted account with no organization credentials.");
        }

        try {
          await validateSandstormLoginAttempt({
            allowed: true,
            connection: { sandstormDb: globalDb },
            user: nonOrgAccount,
          });
          throw new Meteor.Error("org-login-non-member-accepted",
              "Login validation accepted non-organization account while guests are disabled.");
        } catch (err) {
          if (err.error !== 403 || !/User not in organization/i.test(err.message || "")) throw err;
        }

        const accepted = await validateSandstormLoginAttempt({
          allowed: true,
          connection: { sandstormDb: globalDb },
          user: orgAccount,
        });
        if (accepted !== true) {
          throw new Meteor.Error("org-login-member-rejected",
              "Login validation rejected an organization member.");
        }

        const rejectedBeforeValidation = await validateSandstormLoginAttempt({
          allowed: false,
          connection: { sandstormDb: globalDb },
          user: orgAccount,
        });
        if (rejectedBeforeValidation !== false) {
          throw new Meteor.Error("org-login-disallowed",
              "Login validation did not preserve a previously disallowed attempt.");
        }

        return true;
      } finally {
        await globalDb.collections.settings.removeAsync({
          _id: { $in: ["organizationMembership", "organizationSettings"] },
        });
        await Meteor.users.removeAsync({
          _id: {
            $in: [
              orgCredentialId,
              orgAccountNonOrgCredentialId,
              nonOrgCredentialId,
              orgAccountId,
              nonOrgAccountId,
            ],
          },
        });
      }
    },

    testRegressionScheduledJobsPublication: async function () {
      const ownerId = "test-scheduled-owner-" + Random.id();
      const otherId = "test-scheduled-other-" + Random.id();
      const adminId = "test-scheduled-admin-" + Random.id();
      const ownerGrainId = "testScheduledOwnerGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, "");
      const otherGrainId = "testScheduledOtherGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, "");
      const ownerJobId = "test-scheduled-owner-job-" + Random.id();
      const otherJobId = "test-scheduled-other-job-" + Random.id();
      let ownerSub;
      let adminSub;
      let unrelatedSub;
      const waitForPublication = async () => {
        await new Promise((resolve) => Meteor.setTimeout(resolve, 50));
      };
      const startSub = async (userId) => {
        const sub = makeFakeSubscription(userId);
        await getPublishHandler("scheduledJobs").apply(sub, []);
        await waitForPublication();
        return sub;
      };

      await Meteor.users.insertAsync({
        _id: ownerId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Scheduled owner" },
      });
      await Meteor.users.insertAsync({
        _id: otherId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Scheduled other" },
      });
      await Meteor.users.insertAsync({
        _id: adminId,
        type: "account",
        signupKey: "admin",
        isAdmin: true,
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Scheduled admin" },
      });
      await globalDb.collections.grains.insertAsync({
        _id: ownerGrainId,
        userId: ownerId,
        appId: "scheduled-app",
        packageId: "scheduled-package",
        appVersion: 1,
        title: "Owner scheduled grain",
      });
      await globalDb.collections.grains.insertAsync({
        _id: otherGrainId,
        userId: otherId,
        appId: "scheduled-app",
        packageId: "scheduled-package",
        appVersion: 1,
        title: "Other scheduled grain",
      });
      await globalDb.collections.scheduledJobs.insertAsync({
        _id: ownerJobId,
        grainId: ownerGrainId,
        name: "owner job",
        created: new Date(),
        nextPeriodStart: new Date(),
        period: "daily",
      });
      await globalDb.collections.scheduledJobs.insertAsync({
        _id: otherJobId,
        grainId: otherGrainId,
        name: "other job",
        created: new Date(),
        nextPeriodStart: new Date(),
        period: "daily",
      });

      try {
        ownerSub = await startSub(ownerId);
        if (!ownerSub.addedDocs.scheduledJobs ||
            !ownerSub.addedDocs.scheduledJobs[ownerJobId] ||
            ownerSub.addedDocs.scheduledJobs[otherJobId]) {
          throw new Meteor.Error("scheduled-owner-scope",
              "scheduledJobs did not publish only the owner's jobs.");
        }

        adminSub = await startSub(adminId);
        if (!adminSub.addedDocs.scheduledJobs ||
            !adminSub.addedDocs.scheduledJobs[ownerJobId] ||
            !adminSub.addedDocs.scheduledJobs[otherJobId]) {
          throw new Meteor.Error("scheduled-admin-scope",
              "scheduledJobs did not publish all jobs to admins.");
        }

        unrelatedSub = await startSub(otherId);
        if (!unrelatedSub.addedDocs.scheduledJobs ||
            unrelatedSub.addedDocs.scheduledJobs[ownerJobId]) {
          throw new Meteor.Error("scheduled-unrelated-scope",
              "scheduledJobs published another user's job to an unrelated user.");
        }

        await globalDb.collections.scheduledJobs.updateAsync(ownerJobId, {
          $set: { grainId: otherGrainId, name: "moved job" },
        });
        await waitForPublication();

        if (!ownerSub.removedDocs.scheduledJobs ||
            !ownerSub.removedDocs.scheduledJobs[ownerJobId]) {
          throw new Meteor.Error("scheduled-changed-ownership",
              "scheduledJobs did not remove a job after ownership changed away.");
        }

        return true;
      } finally {
        if (ownerSub) ownerSub.stop();
        if (adminSub) adminSub.stop();
        if (unrelatedSub) unrelatedSub.stop();
        await globalDb.collections.scheduledJobs.removeAsync({ _id: { $in: [ownerJobId, otherJobId] } });
        await globalDb.collections.grains.removeAsync({ _id: { $in: [ownerGrainId, otherGrainId] } });
        await Meteor.users.removeAsync({ _id: { $in: [ownerId, otherId, adminId] } });
      }
    },

    testRegressionNotifications: async function () {
      const userId = "test-notification-user-" + Random.id();
      const otherUserId = "test-notification-other-" + Random.id();
      const initiatingUserId = "test-notification-initiator-" + Random.id();
      const normalNotificationId = "test-notification-normal-" + Random.id();
      const appUpdateNotificationId = "test-notification-app-update-" + Random.id();
      const otherNotificationId = "test-notification-other-doc-" + Random.id();
      const scopedNotificationId = "test-notification-scoped-" + Random.id();
      const appCleanupCalls = [];
      const originalDeleteUnusedPackages = globalDb.deleteUnusedPackages;
      const callDismiss = async (callerId, notificationId) => {
        return await getMethodHandler("dismissNotification").apply({
          userId: callerId,
          connection: {
            sandstormDb: globalDb,
            sandstormBackend: globalThis.globalBackend,
          },
        }, [notificationId]);
      };
      const callReadAll = async (callerId) => {
        return await getMethodHandler("readAllNotifications").apply({
          userId: callerId,
          connection: {
            sandstormDb: globalDb,
            sandstormBackend: globalThis.globalBackend,
          },
        }, []);
      };

      await Meteor.users.insertAsync({
        _id: userId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Notification user" },
      });
      await Meteor.users.insertAsync({
        _id: otherUserId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Notification other user" },
      });
      await Meteor.users.insertAsync({
        _id: initiatingUserId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Notification initiating user" },
      });
      await globalDb.collections.notifications.insertAsync({
        _id: normalNotificationId,
        userId,
        timestamp: new Date(),
        isUnread: true,
        referral: true,
      });
      await globalDb.collections.notifications.insertAsync({
        _id: appUpdateNotificationId,
        userId,
        timestamp: new Date(),
        isUnread: true,
        appUpdates: {
          "test-app-a": { packageId: "package-a" },
          "test-app-b": { packageId: "package-b" },
        },
      });
      await globalDb.collections.notifications.insertAsync({
        _id: otherNotificationId,
        userId: otherUserId,
        timestamp: new Date(),
        isUnread: true,
        referral: true,
      });
      await globalDb.collections.notifications.insertAsync({
        _id: scopedNotificationId,
        userId,
        timestamp: new Date(),
        isUnread: true,
        grainId: "testNotificationGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, ""),
        initiatingAccount: initiatingUserId,
      });

      globalDb.deleteUnusedPackages = async function (appId) {
        appCleanupCalls.push(appId);
      };

      try {
        try {
          await callDismiss(userId, otherNotificationId);
          throw new Meteor.Error("notification-non-owner-dismissed",
              "dismissNotification allowed a non-owner to dismiss a notification.");
        } catch (err) {
          if (err.error !== 403) throw err;
        }

        await callReadAll(userId);
        const normalAfterRead = await globalDb.collections.notifications.findOneAsync(normalNotificationId);
        const appUpdateAfterRead =
            await globalDb.collections.notifications.findOneAsync(appUpdateNotificationId);
        const otherAfterRead = await globalDb.collections.notifications.findOneAsync(otherNotificationId);
        if (normalAfterRead.isUnread ||
            appUpdateAfterRead.isUnread ||
            otherAfterRead.isUnread !== true) {
          throw new Meteor.Error("notification-read-all-scope",
              "readAllNotifications did not mark only current-user notifications as read.");
        }

        await callDismiss(userId, normalNotificationId);
        if (await globalDb.collections.notifications.findOneAsync(normalNotificationId)) {
          throw new Meteor.Error("notification-not-dismissed",
              "dismissNotification did not remove an owned notification.");
        }

        await callDismiss(userId, appUpdateNotificationId);
        await new Promise((resolve) => Meteor.setTimeout(resolve, 25));
        if (!appCleanupCalls.includes("test-app-a") || !appCleanupCalls.includes("test-app-b")) {
          throw new Meteor.Error("notification-app-update-cleanup",
              "dismissNotification did not trigger app-update package cleanup.");
        }

        const sub = makeFakeSubscription(userId);
        const cursors = await getPublishHandler("notificationGrains").apply(sub, [
          [scopedNotificationId, otherNotificationId],
        ]);
        if (!Array.isArray(cursors) || cursors.length !== 1) {
          throw new Meteor.Error("notification-grains-cursor",
              "notificationGrains did not return expected cursor list.");
        }

        const accounts = await cursors[0].fetchAsync();
        if (accounts.length !== 1 || accounts[0]._id !== initiatingUserId) {
          throw new Meteor.Error("notification-grains-scope",
              "notificationGrains did not return only accounts referenced by requesting user's notifications.");
        }

        return true;
      } finally {
        globalDb.deleteUnusedPackages = originalDeleteUnusedPackages;
        await globalDb.collections.notifications.removeAsync({
          _id: {
            $in: [
              normalNotificationId,
              appUpdateNotificationId,
              otherNotificationId,
              scopedNotificationId,
            ],
          },
        });
        await Meteor.users.removeAsync({ _id: { $in: [userId, otherUserId, initiatingUserId] } });
      }
    },

    testRegressionAdminMethods: async function () {
      const adminId = "test-admin-account-" + Random.id();
      const targetUserId = "test-admin-target-" + Random.id();
      const credentialId = "test-admin-credential-" + Random.id();
      const activityStatId = "test-admin-activity-" + Random.id();
      const apiTokenId = "test-admin-api-token-" + Random.id();
      const inviteEmail = "admin-quota-invite-" + Random.id() + "@example.com";
      const sentInviteEmail1 = "admin-invite-one-" + Random.id() + "@example.com";
      const sentInviteEmail2 = "admin-invite-two-" + Random.id() + "@example.com";
      const userEmail = "admin-quota-user-" + Random.id() + "@example.com";
      const sentAdminEmails = [];
      const settingIds = [
        "github",
        "oidc",
        "smtpConfig",
        "testAdminSetting",
        "organizationMembership",
        "organizationSettings",
        "tlsKeys",
      ];
      const originalTlsCallback = globalThis.currentTlsKeysCallback;

      const adminContext = {
        userId: adminId,
        connection: {
          sandstormDb: globalDb,
          sandstormBackend: globalThis.globalBackend,
        },
        unblock() {},
      };
      const callAdminMethod = async (name, args) => {
        return await getMethodHandler(name).apply(adminContext, args);
      };

      await globalDb.collections.settings.removeAsync({ _id: { $in: settingIds } });
      await ServiceConfiguration.configurations.removeAsync({ service: { $in: ["github", "oidc"] } });
      setAdminEmailSenderForTests(async function (message) {
        await new Promise((resolve) => Meteor.setTimeout(resolve, 5));
        sentAdminEmails.push(message);
      });

      await Meteor.users.insertAsync({
        _id: adminId,
        type: "account",
        isAdmin: true,
        loginCredentials: [],
        nonloginCredentials: [],
        services: { resume: { loginTokens: [{ token: adminId + "-token" }] } },
        profile: { name: "Admin method test admin" },
      });

      await Meteor.users.insertAsync({
        _id: targetUserId,
        type: "account",
        signupEmail: userEmail,
        loginCredentials: [{ id: credentialId }],
        nonloginCredentials: [],
        services: { resume: { loginTokens: [{ token: targetUserId + "-token" }] } },
        profile: { name: "Admin method test target" },
      });

      await Meteor.users.insertAsync({
        _id: credentialId,
        type: "credential",
        services: {
          github: { id: "github-user-id" },
          resume: { loginTokens: [{ token: credentialId + "-token" }] },
        },
        profile: { name: "Admin method test credential" },
      });

      await globalDb.collections.signupKeys.insertAsync({
        _id: "test-admin-quota-key-" + Random.id(),
        used: false,
        email: inviteEmail,
        note: "Admin quota invite",
      });

      await globalDb.collections.activityStats.insertAsync({
        _id: activityStatId,
        timestamp: new Date(),
        activeUsers: 1,
      });

      await globalDb.collections.apiTokens.insertAsync({
        _id: apiTokenId,
        frontendRef: { ipNetwork: "127.0.0.0/8" },
        owner: { user: { accountId: adminId } },
        created: new Date(),
        requirements: [],
        revoked: false,
      });

      try {
        try {
          await callAdminMethod("setAccountSetting", [null, "github", true]);
          throw new Meteor.Error("admin-github-enabled-without-config",
              "setAccountSetting enabled github without configuration.");
        } catch (err) {
          if (err.error !== 403 || !/configure the github service/i.test(err.message || "")) throw err;
        }

        await ServiceConfiguration.configurations.insertAsync({
          service: "github",
          clientId: "github-client",
          secret: "github-secret",
        });
        await callAdminMethod("setAccountSetting", [null, "github", true]);
        let setting = await globalDb.collections.settings.findOneAsync("github");
        if (!setting || setting.value !== true) {
          throw new Meteor.Error("admin-github-not-enabled", "setAccountSetting did not enable github.");
        }

        await ServiceConfiguration.configurations.insertAsync({
          service: "oidc",
          clientId: "oidc-client",
          secret: "oidc-secret",
        });
        try {
          await callAdminMethod("setAccountSetting", [null, "oidc", true]);
          throw new Meteor.Error("admin-oidc-enabled-without-server",
              "setAccountSetting enabled incomplete OIDC configuration.");
        } catch (err) {
          if (err.error !== 403 || !/full set of server parameters/i.test(err.message || "")) throw err;
        }

        await callAdminMethod("setSetting", [null, "testAdminSetting", "set-value"]);
        setting = await globalDb.collections.settings.findOneAsync("testAdminSetting");
        if (!setting || setting.value !== "set-value") {
          throw new Meteor.Error("admin-setting-not-saved", "setSetting did not persist value.");
        }

        const smtpConfig = {
          hostname: "smtp.example",
          port: 587,
          auth: { user: "smtp-user", pass: "smtp-pass" },
          returnAddress: "no-reply@example.com",
        };
        await callAdminMethod("setSmtpConfig", [null, smtpConfig]);
        setting = await globalDb.collections.settings.findOneAsync("smtpConfig");
        if (!setting || setting.value.hostname !== "smtp.example" || setting.value.port !== 587) {
          throw new Meteor.Error("admin-smtp-not-saved", "setSmtpConfig did not persist config.");
        }

        await callAdminMethod("disableEmail", [null]);
        setting = await globalDb.collections.settings.findOneAsync("smtpConfig");
        if (!setting || setting.value.hostname !== "") {
          throw new Meteor.Error("admin-email-not-disabled", "disableEmail did not clear SMTP hostname.");
        }

        const organizationParams = {
          membership: {
            emailToken: { enabled: true, domain: "example.com" },
            google: { enabled: false, domain: "" },
            ldap: { enabled: false },
            oidc: { enabled: true },
            saml: { enabled: false },
          },
          settings: {
            disallowGuests: true,
            shareContacts: false,
          },
        };
        await callAdminMethod("saveOrganizationSettings", [null, organizationParams]);
        const membership = await globalDb.collections.settings.findOneAsync("organizationMembership");
        const orgSettings = await globalDb.collections.settings.findOneAsync("organizationSettings");
        if (!membership || membership.value.oidc.enabled !== true ||
            !orgSettings || orgSettings.value.disallowGuests !== true) {
          throw new Meteor.Error("admin-org-settings-not-saved",
              "saveOrganizationSettings did not persist membership/settings.");
        }

        await callAdminMethod("clearResumeTokensForService", [null, "github"]);
        let account = await Meteor.users.findOneAsync(targetUserId);
        let credential = await Meteor.users.findOneAsync(credentialId);
        if (account.services.resume.loginTokens.length !== 0 ||
            credential.services.resume.loginTokens.length !== 0) {
          throw new Meteor.Error("admin-resume-tokens-not-cleared",
              "clearResumeTokensForService did not clear account and credential tokens.");
        }

        await callAdminMethod("updateQuotas", [null, inviteEmail + "\n" + userEmail, 1234]);
        const invite = await globalDb.collections.signupKeys.findOneAsync({ email: inviteEmail });
        account = await Meteor.users.findOneAsync(targetUserId);
        if (!invite || invite.quota !== 1234 || account.quota !== 1234) {
          throw new Meteor.Error("admin-quotas-not-updated",
              "updateQuotas did not update invite and user quotas.");
        }

        try {
          await callAdminMethod("updateQuotas", [null, "missing-" + Random.id() + "@example.com", 1234]);
          throw new Meteor.Error("admin-missing-quota-address-accepted",
              "updateQuotas accepted an address with no invite/user.");
        } catch (err) {
          if (err.error !== 404) throw err;
        }

        await callAdminMethod("sendInvites", [
          null,
          "https://sandstorm.example",
          { name: "Admin Sender", address: "admin@example.com" },
          sentInviteEmail1 + "\n\n" + sentInviteEmail2,
          "Join this Sandstorm",
          "Click $KEY to join.",
          4321,
        ]);
        if (sentAdminEmails.length !== 2) {
          throw new Meteor.Error("admin-invites-not-sent",
              "sendInvites did not send one message per non-empty address.");
        }

        for (const inviteEmailAddress of [sentInviteEmail1, sentInviteEmail2]) {
          const signupKey = await globalDb.collections.signupKeys.findOneAsync({
            email: inviteEmailAddress,
          });
          const sentEmail = sentAdminEmails.find((email) => email.to === inviteEmailAddress);
          if (!signupKey || signupKey.used !== false || signupKey.definitelySent !== true ||
              signupKey.quota !== 4321 || signupKey.note !== "E-mail invite to " + inviteEmailAddress) {
            throw new Meteor.Error("admin-invite-key-not-created",
                "sendInvites did not create expected signup key for " + inviteEmailAddress);
          }

          if (!sentEmail ||
              sentEmail.from.name !== "Admin Sender" ||
              sentEmail.from.address !== "admin@example.com" ||
              sentEmail.envelopeFrom !== "no-reply@example.com" ||
              sentEmail.subject !== "Join this Sandstorm" ||
              !sentEmail.text.includes("https://sandstorm.example/signup/" + signupKey._id)) {
            throw new Meteor.Error("admin-invite-email-content",
                "sendInvites did not send expected email for " + inviteEmailAddress);
          }
        }

        let tlsCallbackCalled = false;
        globalThis.currentTlsKeysCallback = {
          async setKeys(key, certChain) {
            tlsCallbackCalled = true;
            if (key !== "test-key" || certChain !== "test-cert") {
              throw new Meteor.Error("admin-tls-callback-values",
                  "setTlsKeys passed unexpected values to currentTlsKeysCallback.");
            }
          },
        };
        await callAdminMethod("setTlsKeys", [null, { key: "test-key", certChain: "test-cert" }]);
        setting = await globalDb.collections.settings.findOneAsync("tlsKeys");
        if (!tlsCallbackCalled || !setting ||
            setting.value.key !== "test-key" || setting.value.certChain !== "test-cert") {
          throw new Meteor.Error("admin-tls-not-saved",
              "setTlsKeys did not validate and persist TLS keys.");
        }

        globalThis.currentTlsKeysCallback = {
          async setKeys() {
            throw new Meteor.Error("synthetic-tls-failure", "Synthetic TLS validation failure.");
          },
        };
        try {
          await callAdminMethod("setTlsKeys", [null, { key: "bad-key", certChain: "bad-cert" }]);
          throw new Meteor.Error("admin-tls-failure-accepted",
              "setTlsKeys saved keys after callback failure.");
        } catch (err) {
          if (err.error !== "synthetic-tls-failure") throw err;
        }

        setting = await globalDb.collections.settings.findOneAsync("tlsKeys");
        if (setting.value.key !== "test-key" || setting.value.certChain !== "test-cert") {
          throw new Meteor.Error("admin-tls-failure-saved",
              "setTlsKeys changed persisted keys after callback failure.");
        }

        const expectUnauthorizedPublicationDenied = async (name, args) => {
          const result = await getPublishHandler(name).apply(makeFakeSubscription(null), args || []);
          if (Array.isArray(result) && result.length === 0) return;
          throw new Meteor.Error("admin-publication-unauthorized",
              name + " returned data for an unauthorized caller.");
        };
        const expectAdminCursorIncludes = async (name, args, expectedId) => {
          const result = await getPublishHandler(name).apply(makeFakeSubscription(adminId), args || []);
          if (!result || typeof result.fetchAsync !== "function") {
            throw new Meteor.Error("admin-publication-no-cursor",
                name + " did not return a cursor for an admin.");
          }

          const docs = await result.fetchAsync();
          if (!docs.some((doc) => doc._id === expectedId)) {
            throw new Meteor.Error("admin-publication-missing-doc",
                name + " did not include expected doc " + expectedId + ".");
          }
        };

        await expectUnauthorizedPublicationDenied("admin", [null]);
        await expectAdminCursorIncludes("admin", [null], "github");
        const adminSettings = await getPublishHandler("admin").apply(makeFakeSubscription(adminId), [null])
            .then((cursor) => cursor.fetchAsync());
        if (adminSettings.some((doc) => doc._id === "tlsKeys")) {
          throw new Meteor.Error("admin-publication-leaked-tls", "admin publication exposed TLS keys.");
        }

        await expectUnauthorizedPublicationDenied("allUsers", [null]);
        await expectAdminCursorIncludes("allUsers", [null], targetUserId);

        await expectUnauthorizedPublicationDenied("activityStats", [null]);
        await expectAdminCursorIncludes("activityStats", [null], activityStatId);

        await expectUnauthorizedPublicationDenied("adminApiTokens", [null]);
        await expectAdminCursorIncludes("adminApiTokens", [null], apiTokenId);

        await expectUnauthorizedPublicationDenied("adminUserDetails", [targetUserId]);
        const userDetailsSub = makeFakeSubscription(adminId);
        await getPublishHandler("adminUserDetails").apply(userDetailsSub, [targetUserId]);
        await new Promise((resolve) => Meteor.setTimeout(resolve, 25));
        userDetailsSub.stop();
        if (!userDetailsSub.readyCalled ||
            !userDetailsSub.addedDocs.users ||
            !userDetailsSub.addedDocs.users[targetUserId]) {
          throw new Meteor.Error("admin-user-details-missing-account",
              "adminUserDetails did not publish the requested account for an admin.");
        }

        return true;
      } finally {
        setAdminEmailSenderForTests(null);
        globalThis.currentTlsKeysCallback = originalTlsCallback;
        await ServiceConfiguration.configurations.removeAsync({ service: { $in: ["github", "oidc"] } });
        await globalDb.collections.settings.removeAsync({ _id: { $in: settingIds } });
        await globalDb.collections.signupKeys.removeAsync({
          email: { $in: [inviteEmail, sentInviteEmail1, sentInviteEmail2] },
        });
        await globalDb.collections.activityStats.removeAsync(activityStatId);
        await globalDb.collections.apiTokens.removeAsync(apiTokenId);
        await Meteor.users.removeAsync({ _id: { $in: [adminId, targetUserId, credentialId] } });
      }
    },

    testRegressionPaymentWebhooksAndMailchimp: async function () {
      const invoiceUserId = "test-payments-invoice-" + Random.id();
      const invoiceCredentialId = "test-payments-invoice-credential-" + Random.id();
      const failureUserId = "test-payments-failure-" + Random.id();
      const failureCredentialId = "test-payments-failure-credential-" + Random.id();
      const deletedUserId = "test-payments-deleted-" + Random.id();
      const activeSubUserId = "test-payments-active-sub-" + Random.id();
      const mailchimpUserId = "test-payments-mailchimp-" + Random.id();
      const mailchimpCredentialId = "test-payments-mailchimp-credential-" + Random.id();
      const sentPaymentEmails = [];
      const deletedSubscriptions = [];
      const originalEventsRetrieve = testStripe.events.retrieve;
      const originalCustomersRetrieve = testStripe.customers.retrieve;
      const originalSubscriptionsDel = testStripe.subscriptions.del;
      const originalSandstormEmail = globalThis.SandstormEmail;
      const oldMailchimpListId = Meteor.settings.mailchimpListId;
      const oldMailchimpKey = Meteor.settings.mailchimpKey;
      const eventById = {};

      const insertAccountWithEmail = async (accountId, credentialId, email, extraFields) => {
        await Meteor.users.insertAsync({
          _id: credentialId,
          type: "credential",
          services: { email: { email } },
          profile: { name: "Payments test credential" },
        });
        await Meteor.users.insertAsync({
          _id: accountId,
          type: "account",
          signupKey: "admin",
          loginCredentials: [{ id: credentialId }],
          nonloginCredentials: [],
          primaryEmail: email,
          profile: { name: "Payments test account" },
          ...extraFields,
        });
      };

      await globalDb.collections.plans.upsertAsync("pro", {
        $set: {
          title: "Pro",
          storage: 10 * 1024 * 1024,
          compute: 100,
          grains: 100,
        },
      });
      await insertAccountWithEmail(invoiceUserId, invoiceCredentialId,
          "payments-invoice@example.com", { payments: { id: "cus_invoice" }, plan: "pro" });
      await insertAccountWithEmail(failureUserId, failureCredentialId,
          "payments-failure@example.com", { payments: { id: "cus_failure" }, plan: "pro" });
      await Meteor.users.insertAsync({
        _id: deletedUserId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Payments deleted subscription account" },
        payments: { id: "cus_deleted" },
        plan: "pro",
      });
      await Meteor.users.insertAsync({
        _id: activeSubUserId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Payments active subscription account" },
        payments: { id: "cus_active_sub" },
        plan: "pro",
      });
      await insertAccountWithEmail(mailchimpUserId, mailchimpCredentialId,
          "mailchimp-user@example.com", {});

      globalThis.SandstormEmail = {
        async send(message) {
          sentPaymentEmails.push(message);
        },
      };
      testStripe.events.retrieve = async function (eventId) {
        return eventById[eventId];
      };
      testStripe.customers.retrieve = async function (customerId) {
        if (customerId === "cus_failure") {
          return {
            email: "payments-failure@example.com",
            subscriptions: { data: [{ id: "sub_failure" }] },
          };
        } else if (customerId === "cus_deleted") {
          return { subscriptions: { data: [] } };
        } else if (customerId === "cus_active_sub") {
          return { subscriptions: { data: [{ id: "sub_active" }] } };
        }

        return { email: "fallback@example.com", subscriptions: { data: [] } };
      };
      testStripe.subscriptions.del = async function (subscriptionId) {
        deletedSubscriptions.push(subscriptionId);
      };

      try {
        eventById.invoice_success = {
          id: "invoice_success",
          type: "invoice.payment_succeeded",
          created: 100,
          data: {
            object: {
              customer: "cus_invoice",
              amount_due: 1000,
              total: 1000,
              lines: {
                data: [
                  { type: "subscription", plan: { id: "pro-monthly" }, amount: 1000 },
                  { type: "invoiceitem", description: "Extra storage", amount: 250 },
                ],
              },
            },
          },
        };
        await handleWebhookEvent(globalDb, { id: "invoice_success" });
        let invoiceUser = await Meteor.users.findOneAsync(invoiceUserId);
        if (invoiceUser.payments.lastInvoiceTime !== 100 ||
            sentPaymentEmails.length !== 1 ||
            sentPaymentEmails[0].to !== "payments-invoice@example.com" ||
            !/Invoice from/i.test(sentPaymentEmails[0].subject || "")) {
          throw new Meteor.Error("payments-invoice-success",
              "Successful invoice webhook did not update invoice time and send invoice email.");
        }

        eventById.invoice_duplicate = {
          ...eventById.invoice_success,
          id: "invoice_duplicate",
          created: 99,
        };
        await handleWebhookEvent(globalDb, { id: "invoice_duplicate" });
        invoiceUser = await Meteor.users.findOneAsync(invoiceUserId);
        if (invoiceUser.payments.lastInvoiceTime !== 100 || sentPaymentEmails.length !== 1) {
          throw new Meteor.Error("payments-invoice-duplicate",
              "Duplicate/old invoice webhook was not ignored.");
        }

        eventById.invoice_failure = {
          id: "invoice_failure",
          type: "invoice.payment_failed",
          created: 200,
          data: {
            object: {
              customer: "cus_failure",
              lines: { data: [] },
            },
          },
        };
        await handleWebhookEvent(globalDb, { id: "invoice_failure" });
        const failureUser = await Meteor.users.findOneAsync(failureUserId);
        if (failureUser.plan !== "free" ||
            failureUser.payments.lastInvoiceTime !== 200 ||
            !deletedSubscriptions.includes("sub_failure") ||
            sentPaymentEmails.length !== 2 ||
            !/URGENT: Payment failed/i.test(sentPaymentEmails[1].subject || "")) {
          throw new Meteor.Error("payments-invoice-failure",
              "Failed invoice webhook did not downgrade, cancel subscription, and send failure email.");
        }

        eventById.subscription_deleted = {
          id: "subscription_deleted",
          type: "customer.subscription.deleted",
          created: 300,
          data: { object: { customer: "cus_deleted" } },
        };
        await handleWebhookEvent(globalDb, { id: "subscription_deleted" });
        const deletedUser = await Meteor.users.findOneAsync(deletedUserId);
        if (deletedUser.plan !== "free") {
          throw new Meteor.Error("payments-subscription-delete",
              "Subscription deletion webhook did not downgrade customer with no active subscriptions.");
        }

        eventById.subscription_still_active = {
          id: "subscription_still_active",
          type: "customer.subscription.deleted",
          created: 301,
          data: { object: { customer: "cus_active_sub" } },
        };
        await handleWebhookEvent(globalDb, { id: "subscription_still_active" });
        const activeSubUser = await Meteor.users.findOneAsync(activeSubUserId);
        if (activeSubUser.plan !== "pro") {
          throw new Meteor.Error("payments-subscription-active",
              "Subscription deletion webhook downgraded a customer with active subscriptions.");
        }

        Meteor.settings.mailchimpListId = "mailchimp-list";
        Meteor.settings.mailchimpKey = "mailchimpkey-us1";
        setPaymentsHttpCallForTests(async function (method, url, options) {
          if (method !== "GET" ||
              !url.includes("https://us1.api.mailchimp.com/3.0/lists/mailchimp-list/members") ||
              !options ||
              options.headers.Authorization !== "apikey mailchimpkey-us1") {
            throw new Error("Unexpected Mailchimp request: " + method + " " + url);
          }

          return {
            data: {
              total_items: 1,
              members: [{
                email_address: "mailchimp-user@example.com",
                status: "subscribed",
                last_changed: "2026-05-01T12:00:00+00:00",
              }],
            },
          };
        });
        await updateMailchimp(globalDb);
        const subscriber = await MailchimpSubscribers.findOneAsync("mailchimp-user@example.com");
        const mailchimpUser = await Meteor.users.findOneAsync(mailchimpUserId);
        if (!subscriber || subscriber.canonical !== "mailchimp-user@example.com" ||
            subscriber.subscribed !== true ||
            !mailchimpUser.payments ||
            !mailchimpUser.payments.bonuses ||
            mailchimpUser.payments.bonuses.mailingList !== true ||
            mailchimpUser.planBonus.storage !== MAILING_LIST_BONUS) {
          throw new Meteor.Error("payments-mailchimp-update",
              "Mailchimp update did not refresh subscriber state and user bonuses.");
        }

        return true;
      } finally {
        testStripe.events.retrieve = originalEventsRetrieve;
        testStripe.customers.retrieve = originalCustomersRetrieve;
        testStripe.subscriptions.del = originalSubscriptionsDel;
        globalThis.SandstormEmail = originalSandstormEmail;
        Meteor.settings.mailchimpListId = oldMailchimpListId;
        Meteor.settings.mailchimpKey = oldMailchimpKey;
        setPaymentsHttpCallForTests(null);
        await MailchimpSubscribers.removeAsync({ _id: "mailchimp-user@example.com" });
        await globalDb.collections.plans.removeAsync("pro");
        await Meteor.users.removeAsync({
          _id: {
            $in: [
              invoiceUserId,
              invoiceCredentialId,
              failureUserId,
              failureCredentialId,
              deletedUserId,
              activeSubUserId,
              mailchimpUserId,
              mailchimpCredentialId,
            ],
          },
        });
      }
    },

    testRegressionTransferMethods: async function () {
      const userId = "test-transfer-account-" + Random.id();
      const unsignedUserId = "test-transfer-unsigned-" + Random.id();
      const otherUserId = "test-transfer-other-" + Random.id();
      const originalHttpDel = HTTP.del;
      const transferIds = [];
      const outgoingIds = [];
      const revokedUrls = [];
      const contextFor = (id) => ({
        userId: id,
        connection: {
          sandstormDb: globalDb,
          sandstormBackend: globalThis.globalBackend,
        },
      });
      const callTransferMethod = async (name, user, args) => {
        return await getMethodHandler(name).apply(contextFor(user), args);
      };

      await Meteor.users.insertAsync({
        _id: userId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Transfer test account" },
      });
      await Meteor.users.insertAsync({
        _id: otherUserId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Transfer other account" },
      });
      await Meteor.users.insertAsync({
        _id: unsignedUserId,
        type: "account",
        expires: new Date(Date.now() + 100000),
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Transfer unsigned account" },
      });

      HTTP.del = function (url, _options, callback) {
        revokedUrls.push(url);
        if (callback) callback(null, { statusCode: 200 });
      };
      setTransferDownloaderDisabledForTests(true);

      setTransferHttpCallForTests(async function (method, url, options) {
        if (method !== "GET" ||
            url !== "https://source.example/transfers/list" ||
            !options ||
            options.headers.Authorization !== "Bearer " + "b".repeat(64)) {
          throw new Error("Unexpected transfer HTTP call: " + method + " " + url);
        }

        return {
          data: {
            isSansdtormTransferList: true,
            grains: [
              {
                _id: "grainA",
                appId: "app-a",
                appVersion: 1,
                packageId: "pkg-a",
                title: "Transfer Grain A",
                size: 100,
                lastUsed: 200,
              },
              {
                _id: "grainB",
                appId: "app-b",
                appVersion: 2,
                packageId: "pkg-b",
                title: "Transfer Grain B",
              },
            ],
          },
        };
      });

      try {
        try {
          await callTransferMethod("newTransfer", null, ["https://dest.example"]);
          throw new Meteor.Error("transfer-new-unauthenticated",
              "newTransfer allowed an unauthenticated caller.");
        } catch (err) {
          if (err.error !== 403) throw err;
        }

        try {
          await callTransferMethod("newTransfer", unsignedUserId, ["https://dest.example"]);
          throw new Meteor.Error("transfer-new-unsigned",
              "newTransfer allowed a non-signed-up account.");
        } catch (err) {
          if (err.error !== 403) throw err;
        }

        try {
          await callTransferMethod("newTransfer", userId, ["ftp://dest.example"]);
          throw new Meteor.Error("transfer-new-invalid-url", "newTransfer accepted invalid destination.");
        } catch (err) {
          if (err.error !== 400) throw err;
        }

        const token = await callTransferMethod("newTransfer", userId, ["https://dest.example"]);
        if (!/^[0-9a-f]{64}$/.test(token)) {
          throw new Meteor.Error("transfer-new-token-shape", "newTransfer returned malformed token.");
        }

        const hash = Crypto.createHash("sha256").update(token).digest("hex");
        outgoingIds.push(hash);
        const outgoing = await globalDb.collections.outgoingTransfers.findOneAsync(hash);
        if (!outgoing || outgoing.userId !== userId || outgoing.destination !== "https://dest.example") {
          throw new Meteor.Error("transfer-new-not-hashed",
              "newTransfer did not persist hashed outgoing transfer token.");
        }

        try {
          await callTransferMethod("acceptTransfer", userId, ["https://source.example", "bad-token"]);
          throw new Meteor.Error("transfer-accept-invalid-token",
              "acceptTransfer accepted invalid token shape.");
        } catch (err) {
          if (err.error !== 400) throw err;
        }

        await globalDb.collections.outgoingTransfers.removeAsync(hash);
        await callTransferMethod("acceptTransfer", userId, ["https://source.example", "b".repeat(64)]);
        let transfers = await globalDb.collections.incomingTransfers.find({ userId }).fetchAsync();
        if (transfers.length !== 2 ||
            !transfers.every((transfer) => transfer.selected === true &&
              transfer.source === "https://source.example" &&
              transfer.token === "b".repeat(64))) {
          throw new Meteor.Error("transfer-accept-not-inserted",
              "acceptTransfer did not insert expected incoming transfers.");
        }
        transferIds.push(...transfers.map((transfer) => transfer._id));

        const otherTransferId = await globalDb.collections.incomingTransfers.insertAsync({
          userId: otherUserId,
          source: "https://source.example",
          token: "c".repeat(64),
          grainId: "otherGrain",
          appId: "other-app",
          appVersion: 1,
          packageId: "other-package",
          title: "Other transfer",
          selected: true,
        });
        transferIds.push(otherTransferId);

        await callTransferMethod("setTransferSelected", userId, [transfers[0]._id, false]);
        let updated = await globalDb.collections.incomingTransfers.findOneAsync(transfers[0]._id);
        let otherUpdated = await globalDb.collections.incomingTransfers.findOneAsync(otherTransferId);
        if (updated.selected !== false || otherUpdated.selected !== true) {
          throw new Meteor.Error("transfer-selected-ownership",
              "setTransferSelected did not preserve ownership boundaries.");
        }

        await callTransferMethod("setTransferSelected", userId, [null, false]);
        transfers = await globalDb.collections.incomingTransfers.find({ userId }).fetchAsync();
        if (!transfers.every((transfer) => transfer.selected === false)) {
          throw new Meteor.Error("transfer-selected-all",
              "setTransferSelected(null) did not update all current-user transfers.");
        }

        await callTransferMethod("setTransferSelected", userId, [null, true]);
        await callTransferMethod("setTransferRunning", userId, [true]);
        transfers = await globalDb.collections.incomingTransfers.find({ userId }).fetchAsync();
        if (transfers.filter((transfer) => transfer.downloading).length !== 1) {
          throw new Meteor.Error("transfer-running-not-started",
              "setTransferRunning(true) did not start exactly one transfer.");
        }

        await callTransferMethod("setTransferRunning", userId, [false]);
        transfers = await globalDb.collections.incomingTransfers.find({ userId }).fetchAsync();
        if (transfers.some((transfer) => transfer.downloading)) {
          throw new Meteor.Error("transfer-running-not-stopped",
              "setTransferRunning(false) did not clear downloading state.");
        }

        await globalDb.collections.incomingTransfers.updateAsync(
            { _id: transfers[0]._id },
            { $set: { error: "boom", remoteFileToken: "remote", localFileToken: "local" } });
        await globalDb.collections.incomingTransfers.updateAsync(
            { _id: otherTransferId },
            { $set: { error: "other-boom", remoteFileToken: "other-remote", localFileToken: "other-local" } });
        await callTransferMethod("clearTransferErrors", userId, []);
        updated = await globalDb.collections.incomingTransfers.findOneAsync(transfers[0]._id);
        otherUpdated = await globalDb.collections.incomingTransfers.findOneAsync(otherTransferId);
        if (updated.error || updated.remoteFileToken || updated.localFileToken ||
            otherUpdated.error !== "other-boom") {
          throw new Meteor.Error("transfer-errors-not-cleared",
              "clearTransferErrors did not clear only current-user error fields.");
        }

        const cancelOutgoingId = await globalDb.collections.outgoingTransfers.insertAsync({
          _id: "test-transfer-outgoing-" + Random.id(),
          userId,
          destination: "https://dest.example",
        });
        outgoingIds.push(cancelOutgoingId);
        await callTransferMethod("cancelTransfers", userId, []);
        if (await globalDb.collections.outgoingTransfers.findOneAsync({ userId }) ||
            await globalDb.collections.incomingTransfers.findOneAsync({ userId })) {
          throw new Meteor.Error("transfer-cancel-current-user",
              "cancelTransfers did not remove current user's transfers.");
        }

        if (!await globalDb.collections.incomingTransfers.findOneAsync(otherTransferId)) {
          throw new Meteor.Error("transfer-cancel-other-user",
              "cancelTransfers removed another user's transfer.");
        }

        if (!revokedUrls.includes("https://source.example/transfers/cancel")) {
          throw new Meteor.Error("transfer-cancel-not-revoked",
              "cancelTransfers did not revoke the remote transfer token.");
        }

        return true;
      } finally {
        HTTP.del = originalHttpDel;
        setTransferDownloaderDisabledForTests(false);
        setTransferHttpCallForTests(null);
        await globalDb.collections.incomingTransfers.removeAsync({
          _id: { $in: transferIds },
        });
        await globalDb.collections.outgoingTransfers.removeAsync({
          _id: { $in: outgoingIds },
        });
        await Meteor.users.removeAsync({ _id: { $in: [userId, unsignedUserId, otherUserId] } });
      }
    },

    testRegressionTransferRoutes: async function () {
      const userId = "test-transfer-route-account-" + Random.id();
      const otherUserId = "test-transfer-route-other-" + Random.id();
      const token = "d".repeat(64);
      const hash = Crypto.createHash("sha256").update(token).digest("hex");
      const grainId = "routeGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, "");
      const otherGrainId = "otherRouteGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, "");
      const authHeaders = { Authorization: "Bearer " + token };
      const captureHttpError = async (fn) => {
        try {
          const response = await fn();
          return { statusCode: response.statusCode, content: response.content, data: response.data };
        } catch (err) {
          if (err.response) {
            return {
              statusCode: err.response.statusCode,
              content: err.response.content,
              data: err.response.data,
            };
          }

          throw err;
        }
      };

      await Meteor.users.insertAsync({
        _id: userId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Transfer route test account" },
      });
      await Meteor.users.insertAsync({
        _id: otherUserId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Transfer route other account" },
      });
      await globalDb.collections.outgoingTransfers.insertAsync({
        _id: hash,
        userId,
        destination: "https://dest.example",
      });
      await globalDb.collections.grains.insertAsync({
        _id: grainId,
        userId,
        appId: "route-app",
        appVersion: 7,
        packageId: "route-package",
        title: "Route grain",
        size: 100,
        lastUsed: new Date("2026-01-01T00:00:00Z"),
      });
      await globalDb.collections.grains.insertAsync({
        _id: otherGrainId,
        userId: otherUserId,
        appId: "other-route-app",
        appVersion: 1,
        packageId: "other-route-package",
        title: "Other route grain",
      });

      try {
        let response = await captureHttpError(async () =>
          await httpCallAsync("GET", Meteor.absoluteUrl("transfers/list")));
        if (response.statusCode !== 403 || !/Missing token/i.test(response.content || "")) {
          throw new Meteor.Error("transfer-list-missing-token",
              "/transfers/list did not reject missing bearer token.");
        }

        response = await captureHttpError(async () =>
          await httpCallAsync("GET", Meteor.absoluteUrl("transfers/list"), {
            headers: { Authorization: "Bearer " + "e".repeat(64) },
          }));
        if (response.statusCode !== 403 || !/Invalid token/i.test(response.content || "")) {
          throw new Meteor.Error("transfer-list-invalid-token",
              "/transfers/list did not reject invalid bearer token.");
        }

        response = await httpCallAsync("GET", Meteor.absoluteUrl("transfers/list"), { headers: authHeaders });
        if (response.statusCode !== 200 ||
            !response.data ||
            response.data.isSansdtormTransferList !== true ||
            response.data.grains.length !== 1 ||
            response.data.grains[0]._id !== grainId ||
            response.data.grains[0].lastUsed !== new Date("2026-01-01T00:00:00Z").getTime()) {
          throw new Meteor.Error("transfer-list-owner-scope",
              "/transfers/list did not return only the transfer owner's grains.");
        }

        setTransferCreateGrainBackupForTests(async function (routeUserId, routeGrainId, isTransfer) {
          if (routeUserId !== userId || routeGrainId !== grainId || isTransfer !== true) {
            throw new Meteor.Error("transfer-prepare-args",
                "/transfers/prepare passed unexpected backup arguments.");
          }

          throw new Meteor.Error(425, "Backup is still pending.");
        });
        response = await captureHttpError(async () =>
          await httpCallAsync("POST", Meteor.absoluteUrl("transfers/prepare/" + grainId), {
            headers: authHeaders,
          }));
        if (response.statusCode !== 425 || !/Backup is still pending/i.test(response.content || "")) {
          throw new Meteor.Error("transfer-prepare-status",
              "/transfers/prepare did not map backup failure to expected status.");
        }

        response = await httpCallAsync("DELETE", Meteor.absoluteUrl("transfers/cancel"), { headers: authHeaders });
        if (response.statusCode !== 200) {
          throw new Meteor.Error("transfer-cancel-status",
              "/transfers/cancel did not return 200 for a valid token.");
        }

        if (await globalDb.collections.outgoingTransfers.findOneAsync(hash)) {
          throw new Meteor.Error("transfer-cancel-token-not-removed",
              "/transfers/cancel did not remove the outgoing transfer token.");
        }

        return true;
      } finally {
        setTransferCreateGrainBackupForTests(null);
        await globalDb.collections.outgoingTransfers.removeAsync(hash);
        await globalDb.collections.grains.removeAsync({ _id: { $in: [grainId, otherGrainId] } });
        await Meteor.users.removeAsync({ _id: { $in: [userId, otherUserId] } });
      }
    },

    testRegressionTransferDownloader: async function () {
      const userId = "test-transfer-downloader-account-" + Random.id();
      const transferIds = [];
      const prepareCalls = [];
      const requestCalls = [];
      const storedTokens = [];
      const restoredTokens = [];
      const insertTransfer = async (fields) => {
        fields = fields || {};
        const transfer = {
          userId,
          source: "https://source.example",
          token: "f".repeat(64),
          grainId: "downloadGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, ""),
          appId: "download-app",
          appVersion: 1,
          packageId: "download-package",
          title: "Downloader test grain",
          selected: true,
        };
        if (!Object.prototype.hasOwnProperty.call(fields, "downloading")) {
          transfer.downloading = true;
        }

        Object.assign(transfer, fields);
        if (transfer.downloading === undefined) delete transfer.downloading;

        const id = await globalDb.collections.incomingTransfers.insertAsync(transfer);
        transferIds.push(id);
        return id;
      };
      const runDownloader = async (transferId) => {
        const transfer = await globalDb.collections.incomingTransfers.findOneAsync(transferId);
        const downloader = new Downloader(transfer);
        await downloader.promise;
        return downloader;
      };

      await Meteor.users.insertAsync({
        _id: userId,
        type: "account",
        signupKey: "admin",
        loginCredentials: [],
        nonloginCredentials: [],
        profile: { name: "Transfer downloader account" },
      });

      setTransferDownloaderDisabledForTests(true);
      setTransferHttpCallForTests(async function (method, url, options) {
        prepareCalls.push({ method, url, options });
        return { data: { fileToken: "remote-token-" + prepareCalls.length } };
      });

      try {
        let requestStatuses = [425, 200];
        setTransferDownloaderHooksForTests({
          request(source, remoteFileToken) {
            requestCalls.push({ source, remoteFileToken });
            return makeTransferRequest(requestStatuses.shift());
          },
          async createBackupToken() {
            return "local-file-token";
          },
          async storeGrainBackup(localFileToken, response) {
            storedTokens.push({ localFileToken, statusCode: response.statusCode });
          },
          async restoreGrainBackup(localFileToken, user, transfer) {
            restoredTokens.push({ localFileToken, userId: user._id, transferId: transfer._id });
            return "local-grain-id";
          },
        });

        const retryTransferId = await insertTransfer({});
        const nextTransferId = await insertTransfer({
          grainId: "nextDownloadGrain" + Random.id().replace(/[^a-zA-Z0-9]/g, ""),
          downloading: undefined,
          lastUsed: 1000,
        });
        await runDownloader(retryTransferId);

        let retryTransfer = await globalDb.collections.incomingTransfers.findOneAsync(retryTransferId);
        let nextTransfer = await globalDb.collections.incomingTransfers.findOneAsync(nextTransferId);
        if (requestCalls.length !== 2 ||
            requestCalls[0].remoteFileToken !== "remote-token-1" ||
            requestCalls[1].remoteFileToken !== "remote-token-1") {
          throw new Meteor.Error("transfer-downloader-no-425-retry",
              "Downloader did not retry a 425 response with the same remote token.");
        }

        if (storedTokens.length !== 1 ||
            restoredTokens.length !== 1 ||
            retryTransfer.localGrainId !== "local-grain-id" ||
            retryTransfer.downloading ||
            nextTransfer.downloading !== true) {
          throw new Meteor.Error("transfer-downloader-success",
              "Downloader did not store, restore, finish, and start the next transfer.");
        }

        requestCalls.length = 0;
        prepareCalls.length = 0;
        setTransferDownloaderHooksForTests({
          request(source, remoteFileToken) {
            requestCalls.push({ source, remoteFileToken });
            return makeTransferRequest(403);
          },
        });
        const invalidRemoteTransferId = await insertTransfer({
          remoteFileToken: "stale-remote-token",
        });
        await runDownloader(invalidRemoteTransferId);

        const invalidRemoteTransfer =
            await globalDb.collections.incomingTransfers.findOneAsync(invalidRemoteTransferId);
        if (invalidRemoteTransfer.remoteFileToken ||
            !/HTTP error: 403/i.test(invalidRemoteTransfer.error || "") ||
            invalidRemoteTransfer.downloading) {
          throw new Meteor.Error("transfer-downloader-token-not-invalidated",
              "Downloader did not invalidate stale remote token after 403.");
        }

        setTransferDownloaderHooksForTests({
          request(_source, _remoteFileToken) {
            return makeTransferRequest(new Error("Synthetic download failure."));
          },
        });
        const canceledTransferId = await insertTransfer({});
        Meteor.setTimeout(() => {
          globalDb.collections.incomingTransfers.updateAsync(
              { _id: canceledTransferId }, { $unset: { downloading: 1 } }).catch((err) => {
            console.error("Failed to unset downloading during transfer cancellation test:", err);
          });
        }, 0);
        await runDownloader(canceledTransferId);

        const canceledTransfer = await globalDb.collections.incomingTransfers.findOneAsync(canceledTransferId);
        if (canceledTransfer.downloading || canceledTransfer.error) {
          throw new Meteor.Error("transfer-downloader-cancel-error",
              "Downloader cancellation did not clear downloading without recording an error.");
        }

        return true;
      } finally {
        setTransferDownloaderHooksForTests(null);
        setTransferHttpCallForTests(null);
        setTransferDownloaderDisabledForTests(false);
        await globalDb.collections.incomingTransfers.removeAsync({ _id: { $in: transferIds } });
        await Meteor.users.removeAsync(userId);
      }
    },
  });
}
