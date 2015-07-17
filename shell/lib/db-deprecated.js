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

// TODO(cleanup): Over time, eliminate the use of each of these assignments by using `db` directly.
//   For collections, prefer to update SandstormDb to provide methods for querying the collection
//   rather than use `db.collections` directly. When code is moved into packages, the `db` global
//   should NOT go with it; the package should expect a SandstormDb to be passed in, thus allowing
//   mocking the database for unit tests.

db = new SandstormDb();

Packages = db.collections.packages;
DevApps = db.collections.devApps;
UserActions = db.collections.userActions;
Grains = db.collections.grains;
Contacts = db.collections.contacts;
Sessions = db.collections.sessions;
SignupKeys = db.collections.signupKeys;
ActivityStats = db.collections.activityStats;
DeleteStats = db.collections.deleteStats;
FileTokens = db.collections.fileTokens;
ApiTokens = db.collections.apiTokens;
Notifications = db.collections.notifications;
StatsTokens = db.collections.statsTokens;
Misc = db.collections.misc;
Settings = db.collections.settings;

isDemoUser = db.isDemoUser.bind(db);
isSignedUp = db.isSignedUp.bind(db);
isSignedUpOrDemo = db.isSignedUpOrDemo.bind(db);
isUserOverQuota = db.isUserOverQuota.bind(db);
isUserExcessivelyOverQuota = db.isUserExcessivelyOverQuota.bind(db);
isAdmin = db.isAdmin.bind(db);
isAdminById = db.isAdminById.bind(db);
findAdminUserForToken = db.findAdminUserForToken.bind(db);
matchWildcardHost = db.matchWildcardHost.bind(db);
makeWildcardHost = db.makeWildcardHost.bind(db);
allowDevAccounts = db.allowDevAccounts.bind(db);
roleAssignmentPattern = db.roleAssignmentPattern;

if (Meteor.isServer) {
  getWildcardOrigin = db.getWildcardOrigin.bind(db);
}
