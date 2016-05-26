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

globalDb = new SandstormDb();

Packages = globalDb.collections.packages;
DevPackages = globalDb.collections.devPackages;
UserActions = globalDb.collections.userActions;
Grains = globalDb.collections.grains;
Contacts = globalDb.collections.contacts;
Sessions = globalDb.collections.sessions;
SignupKeys = globalDb.collections.signupKeys;
ActivityStats = globalDb.collections.activityStats;
DeleteStats = globalDb.collections.deleteStats;
FileTokens = globalDb.collections.fileTokens;
ApiTokens = globalDb.collections.apiTokens;
Notifications = globalDb.collections.notifications;
StatsTokens = globalDb.collections.statsTokens;
Misc = globalDb.collections.misc;
Settings = globalDb.collections.settings;

currentUserGrains = globalDb.currentUserGrains.bind(globalDb);
isDemoUser = globalDb.isDemoUser.bind(globalDb);
isSignedUp = globalDb.isSignedUp.bind(globalDb);
isSignedUpOrDemo = globalDb.isSignedUpOrDemo.bind(globalDb);
isUserOverQuota = globalDb.isUserOverQuota.bind(globalDb);
isUserExcessivelyOverQuota = globalDb.isUserExcessivelyOverQuota.bind(globalDb);
isAdmin = globalDb.isAdmin.bind(globalDb);
isAdminById = globalDb.isAdminById.bind(globalDb);
findAdminUserForToken = globalDb.findAdminUserForToken.bind(globalDb);
matchWildcardHost = globalDb.matchWildcardHost.bind(globalDb);
makeWildcardHost = globalDb.makeWildcardHost.bind(globalDb);
allowDevAccounts = globalDb.allowDevAccounts.bind(globalDb);
roleAssignmentPattern = globalDb.roleAssignmentPattern;

if (Meteor.isServer) {
  getWildcardOrigin = globalDb.getWildcardOrigin.bind(globalDb);

  Meteor.onConnection((connection) => {
    // TODO(cleanup): This is the best way I've thought of so far to allow methods declared in
    //   packages to actually use the DB, but it's pretty sad.
    connection.sandstormDb = globalDb;
  });
  SandstormDb.periodicCleanup(5 * 60 * 1000, SandstormPermissions.cleanupSelfDestructing(globalDb));
  SandstormDb.periodicCleanup(10 * 60 * 1000,
                              SandstormPermissions.cleanupClientPowerboxRequests(globalDb));
  SandstormDb.periodicCleanup(24 * 60 * 60 * 1000, () => {
    SandstormAutoupdateApps.updateAppIndex(globalDb);
  });

  Meteor.startup(() => { globalDb.migrateToLatest(); });
  LDAP_DEFAULTS.url = globalDb.getLdapUrl();
  LDAP_DEFAULTS.base = globalDb.getLdapBase();
}

if (Meteor.isClient) {
  Session.setDefault("shrink-navbar", false);
  globalGrains = new GrainViewList(globalDb);

  // If Meteor._localStorage disappears, we'll have to write our own localStorage wrapper, I guess.
  // Using window.localStorage is dangerous because it throws an exception if cookies are disabled.
  Session.set("shrink-navbar", Meteor._localStorage.getItem("shrink-navbar") === "true");
  globalTopbar = new SandstormTopbar(globalDb,
    {
      get() {
        return Session.get("topbar-expanded");
      },

      set(value) {
        Session.set("topbar-expanded", value);
      },
    },
    globalGrains,
    {
      get() {
        return Session.get("shrink-navbar");
      },

      set(value) {
        Meteor._localStorage.setItem("shrink-navbar", value);
        Session.set("shrink-navbar", value);
      },
    });

  globalAccountsUi = new AccountsUi(globalDb);

  Template.registerHelper("globalTopbar", () => { return globalTopbar; });
  Template.registerHelper("globalAccountsUi", () => { return globalAccountsUi; });
} else {
  // TODO(cleanup): Refactor accounts registration stuff so that this doesn't need to be defined
  //   at all on the server.
  globalAccountsUi = null;
}
