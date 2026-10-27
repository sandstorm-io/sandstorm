// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

import { SandstormDb } from "/imports/sandstorm-db/db";
import { globalDb } from "/imports/db-deprecated";
import { SandstormPermissions } from "/imports/sandstorm-permissions/permissions";
import { globalFrontendRefRegistry } from "/imports/server/frontend-ref";
import { PersistentImpl } from "/imports/server/persistent";
import { migrateToLatest, reconcileOidcUsersIndex } from "/imports/server/migrations";
import { ACCOUNT_DELETION_SUSPENSION_TIME } from "/imports/constants";
import { onInMeteor } from "/imports/server/async-helpers";
import { SandstormAutoupdateApps } from "/imports/sandstorm-autoupdate-apps/autoupdate-apps";
let url = require("url");

export const migrationsReady = migrateToLatest(globalDb, globalThis.globalBackend);
await migrationsReady;
await reconcileOidcUsersIndex(globalDb, globalThis.globalBackend);

process.on('unhandledRejection', (reason, p) => {
  // Please Node, do not crash when a promise rejection isn't caught, thanks.
  console.error("Unhandled exception in Promise: ", reason);
});

process.on('uncaughtException', (err) => {
  // OMG Node, don't abort just because a client disconnected unexpectedly.
  console.error("Unhandled exception: ", err);
});

globalThis.SandstormPowerbox.registerUiViewQueryHandler(globalFrontendRefRegistry);

if (Meteor.settings.public.stripePublicKey && globalThis.BlackrockPayments.registerPaymentsApi) {
  // TODO(cleanup): Meteor.startup() needed because globalThis.unwrapFrontendCap is not defined yet when this
  //   first runs. Move it into an import.
  Meteor.startup(() => {
    globalThis.BlackrockPayments.registerPaymentsApi(
        globalFrontendRefRegistry, PersistentImpl, globalThis.unwrapFrontendCap);
  });
}

globalThis.getWildcardOrigin = globalDb.getWildcardOrigin.bind(globalDb);

Meteor.onConnection((connection) => {
  // TODO(cleanup): This is the best way I've thought of so far to allow methods declared in
  //   packages to actually use the DB, but it's pretty sad.
  connection.sandstormDb = globalDb;
  connection.frontendRefRegistry = globalFrontendRefRegistry;
});
SandstormDb.periodicCleanup(5 * 60 * 1000, SandstormPermissions.cleanupSelfDestructing(globalDb));
SandstormDb.periodicCleanup(10 * 60 * 1000,
                            SandstormPermissions.cleanupClientPowerboxTokens(globalDb));
SandstormDb.periodicCleanup(60 * 60 * 1000, () => {
  globalDb.cleanupExpiredAssetUploads().catch((err) => {
    console.error("Error cleaning up expired asset uploads:", err);
  });
});
SandstormDb.periodicCleanup(24 * 60 * 60 * 1000, () => {
  SandstormAutoupdateApps.updateAppIndex(globalDb).catch((err) => {
    console.error("Error updating app index:", err);
  });
});
const deleteAccount = Meteor.settings.public.stripePublicKey && globalThis.BlackrockPayments.deleteAccount;
SandstormDb.periodicCleanup(24 * 60 * 60 * 1000, () => {
  globalDb.deletePendingAccounts(ACCOUNT_DELETION_SUSPENSION_TIME, globalThis.globalBackend,
      deleteAccount).catch((err) => {
    console.error("Error deleting pending accounts:", err);
  });
});

// If there are multiple replicas, prefix every log message with our replica number.
if ("replicaNumber" in Meteor.settings) {
  const prefix = "replica" + Meteor.settings.replicaNumber.toString() + ":";

  function patchConsole(name) {
    const old = console[name];
    console[name] = function () {
      // Meteor in dev mode writes "LISTENING" to tell the dev runner that it's ready to accept
      // connections.
      if (arguments.length == 1 && arguments[0] == "LISTENING") {
        old.apply(this, arguments);
      } else {
        old.apply(this, [prefix].concat(Array.prototype.slice.call(arguments)));
      }
    };
  }

  patchConsole("log");
  patchConsole("info");
  patchConsole("warn");
  patchConsole("error");
}

const standaloneDomainsCache = new Set();
Meteor.startup(() => {
  globalDb.collections.standaloneDomains.find({}).observeAsync({
    added(doc) {
      standaloneDomainsCache.add(doc._id);
    },

    changed(newDoc, oldDoc) {
      if (oldDoc && oldDoc._id !== newDoc._id) {
        standaloneDomainsCache.delete(oldDoc._id);
      }

      standaloneDomainsCache.add(newDoc._id);
    },

    removed(doc) {
      standaloneDomainsCache.delete(doc._id);
    },
  }).catch((err) => {
    console.error("Failed to observe standaloneDomains cache updates:", err);
  });
});

OAuth._checkRedirectUrlOrigin = function (redirectUrl) {
  // Mostly copied from meteor/packages/oauth/oauth_server.js
  // We override this method in order to support login from stand-alone grain domains.
  let appHost = Meteor.absoluteUrl();
  let appHostReplacedLocalhost = Meteor.absoluteUrl(undefined, {
    replaceLocalhost: true,
  });

  const redirectParsed = url.parse(redirectUrl);

  return !(
    redirectUrl.substr(0, appHost.length) === appHost ||
    redirectUrl.substr(0, appHostReplacedLocalhost.length) === appHostReplacedLocalhost ||
    standaloneDomainsCache.has(redirectParsed.hostname)
  );
};
