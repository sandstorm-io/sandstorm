// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2020 Sandstorm Development Group, Inc. and contributors
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

// =====
// NOTES
// =====
//
// This file exists to reify load order as we try to move everything to modern
// explicit imports.  We'll start by moving files under /imports/ and then
// importing them in the same order that Meteor would have.  This gives us the
// ability to start explicitly importing and exporting variables that we
// currently just rely on being present in the namespace at the right time.
//
// To allow incremental migration, this file's path is explicitly chosen to be
// the very first thing that is loaded out of the application server-side.  We
// can shuffle things around and refactor a lot more easily once we've
// crashlanded everything in /imports/.  Eventually, there will be a single file
// under server/ that imports everything in the order Meteor would have.
//
// Eventually, we'll also move packages in here, above the app's primary
// implementation, since packages are loaded first.
//
// For more information on Meteor's load order, see
// https://guide.meteor.com/structure.html#load-order

// Import packages that sandstorm depends on.

// sandstorm-db.
import "../imports/sandstorm-db/db";
import "../imports/sandstorm-db/profile";
import "../imports/sandstorm-db/scheduled-jobs-db";

// sandstorm-permissions.  Depends on sandstorm-db.
import "../imports/sandstorm-permissions/permissions";

// sandstorm-autoupdate-apps.  Depends on sandstorm-db.
import "../imports/sandstorm-autoupdate-apps/autoupdate-apps";

// sandstorm-accounts-packages
import "../imports/sandstorm-accounts-packages/accounts";

// sandstorm-ui-powerbox.
import "../imports/sandstorm-ui-powerbox/powerbox-server";

// blackrock-payments.  Depends on sandstorm-db
import "../imports/blackrock-payments/constants";
import "../imports/blackrock-payments/server/payments-server";
import "../imports/blackrock-payments/server/payments-api-server";

// oidc
import "../imports/oidc/oidc-server";

// Import everything from server/ in the order that Meteor would have.
import "../imports/server/accounts/credentials/credentials-server";
import "../imports/server/accounts/email-token/token-server";
import "../imports/server/accounts/ldap/ldap-server";
import "../imports/server/accounts/saml/saml-server";
import "../imports/server/accounts/accounts-server";
import "../imports/server/accounts/accounts-ui-methods";
import "../imports/server/accounts/accounts-ui-server";
import "../imports/server/admin/admin-alert-server";
import "../imports/server/admin/admin-user-invite";
import "../imports/server/admin/network-capabilities-server";
import "../imports/server/admin/personalization-server";
import "../imports/server/admin/system-status-server";
import "../imports/server/drivers/external-ui-view";
import "../imports/server/drivers/ip";
import "../imports/server/drivers/mail";
import "../imports/db-deprecated";
import "../imports/server/00-startup";
import "../imports/server/account-suspension";
import "../imports/server/acme";
import "../imports/server/admin-server";
import "../imports/server/backup";
import "../imports/server/contacts-server";
import "../imports/server/core";
import "../imports/server/demo-server";
import "../imports/server/desktop-notifications-server";
import "../imports/server/dev-accounts-server";
import "../imports/server/gateway-router";
import "../imports/server/grain-server";
import "../imports/server/hack-session";
import "../imports/server/identity";
import "../imports/server/installer";
import "../imports/server/install-server";
import "../imports/server/notifications-server";
import "../imports/server/pre-meteor";
import "../imports/server/sandcats";
import "../imports/server/scheduled-job";
import "../imports/server/shell-server";
import "../imports/server/signup-server";
import "../imports/server/standalone-server";
import "../imports/server/startup";
import "../imports/server/stats-server";
import "../imports/server/transfers-server";

import "../imports/shared/admin";
import "../imports/shared/dev-accounts";
import "../imports/shared/grain-shared";

import "../imports/server/testing";
