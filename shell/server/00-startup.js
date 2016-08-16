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

import "/imports/db-deprecated.js";
import { FrontendRefRegistry } from "/imports/server/frontend-ref.js";
import { PersistentImpl } from "/imports/server/persistent.js";
import { migrateToLatest } from "/imports/server/migrations.js";

globalFrontendRefRegistry = new FrontendRefRegistry();

SandstormPowerbox.registerUiViewQueryHandler(globalFrontendRefRegistry);

if (global.BlackrockPayments && BlackrockPayments.registerPaymentsApi) {
  // TODO(cleanup): Meteor.startup() needed because unwrapFrontendCap is not defined yet when this
  //   first runs. Move it into an import.
  Meteor.startup(() => {
    BlackrockPayments.registerPaymentsApi(
        globalFrontendRefRegistry, PersistentImpl, unwrapFrontendCap);
  });
}

getWildcardOrigin = globalDb.getWildcardOrigin.bind(globalDb);

Meteor.onConnection((connection) => {
  // TODO(cleanup): This is the best way I've thought of so far to allow methods declared in
  //   packages to actually use the DB, but it's pretty sad.
  connection.sandstormDb = globalDb;
  connection.frontendRefRegistry = globalFrontendRefRegistry;
});
SandstormDb.periodicCleanup(5 * 60 * 1000, SandstormPermissions.cleanupSelfDestructing(globalDb));
SandstormDb.periodicCleanup(10 * 60 * 1000,
                            SandstormPermissions.cleanupClientPowerboxTokens(globalDb));
SandstormDb.periodicCleanup(24 * 60 * 60 * 1000, () => {
  SandstormAutoupdateApps.updateAppIndex(globalDb);
});

Meteor.startup(() => { migrateToLatest(globalDb); });
