// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

// This file imports symbols from the sandstorm-db package. New code should use SandstormDb
// directly.

// TODO(cleanup): Over time, eliminate the use of each of these assignments by using `globalDb`
//   directly. For collections, prefer to update SandstormDb to provide methods for querying the
//   collection rather than use `globalDb.collections` directly. When code is moved into packages,
//   the `globalDb` global should NOT go with it; the package should expect a SandstormDb to be
//   passed in, thus allowing mocking the database for unit tests.

import { Meteor } from "meteor/meteor";
import { SandstormDb } from "/imports/sandstorm-db/db";

let quotaManager;
if (Meteor.isServer) {
  import { LDAP } from "/imports/server/accounts/ldap";
  // Imports are usually not allowed to occur in a block. However, it is the only way to do
  // this under Meteor. Using // jscs:disable doesn't work for what it considers syntax violations,
  // and so we've added this file to .jscsrc's excludedFiles explicitly.

  quotaManager = new LDAP();
} else {
  quotaManager = {
    updateUserQuota(db, user) {
      return {
        storage: user.cachedStorageQuota || 0,
        grains: Infinity,
        compute: Infinity,
      };
    },
  };
}

export const globalDb = new SandstormDb(quotaManager);

// TODO(cleanup) explicitly export all of these
globalThis.Packages = globalDb.collections.packages;
globalThis.DevPackages = globalDb.collections.devPackages;
globalThis.UserActions = globalDb.collections.userActions;
globalThis.Grains = globalDb.collections.grains;
globalThis.Contacts = globalDb.collections.contacts;
globalThis.Sessions = globalDb.collections.sessions;
globalThis.SignupKeys = globalDb.collections.signupKeys;
globalThis.ActivityStats = globalDb.collections.activityStats;
globalThis.DeleteStats = globalDb.collections.deleteStats;
globalThis.FileTokens = globalDb.collections.fileTokens;
globalThis.ApiTokens = globalDb.collections.apiTokens;
globalThis.Notifications = globalDb.collections.notifications;
globalThis.StatsTokens = globalDb.collections.statsTokens;
globalThis.Misc = globalDb.collections.misc;

globalThis.currentUserGrains = globalDb.currentUserGrains.bind(globalDb);
globalThis.isDemoUser = globalDb.isDemoUser.bind(globalDb);
globalThis.isSignedUp = globalDb.isSignedUp.bind(globalDb);
globalThis.isSignedUpOrDemo = globalDb.isSignedUpOrDemo.bind(globalDb);
globalThis.isUserOverQuota = globalDb.isUserOverQuota.bind(globalDb);
globalThis.isUserExcessivelyOverQuota = globalDb.isUserExcessivelyOverQuota.bind(globalDb);
globalThis.isAdmin = globalDb.isAdmin.bind(globalDb);
globalThis.isAdminById = globalDb.isAdminById.bind(globalDb);
globalThis.findAdminUserForToken = globalDb.findAdminUserForToken.bind(globalDb);
globalThis.matchWildcardHost = globalDb.matchWildcardHost.bind(globalDb);
globalThis.makeWildcardHost = globalDb.makeWildcardHost.bind(globalDb);
globalThis.allowDevAccounts = globalDb.allowDevAccounts.bind(globalDb);
globalThis.roleAssignmentPattern = globalDb.roleAssignmentPattern;
