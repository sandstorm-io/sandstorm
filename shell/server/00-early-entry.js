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

// Import everything from server/ in the order that Meteor would have.
import "../imports/server/accounts/credentials/credentials-server.js";
import "../imports/server/accounts/email-token/token-server.js";
import "../imports/server/accounts/ldap/ldap-server.js";
import "../imports/server/accounts/saml/saml-server.js";
import "../imports/server/accounts/accounts-server.js";
import "../imports/server/accounts/accounts-ui-methods.js";
import "../imports/server/accounts/accounts-ui-server.js";
import "../imports/server/admin/admin-alert-server.js";
import "../imports/server/admin/admin-user-invite.js";
import "../imports/server/admin/network-capabilities-server.js";
import "../imports/server/admin/personalization-server.js";
import "../imports/server/admin/system-status-server.js";
import "../imports/server/drivers/external-ui-view.js";
import "../imports/server/drivers/ip.js";
import "../imports/server/drivers/mail.js";
import "../imports/server/00-startup.js";
import "../imports/server/account-suspension.js";
import "../imports/server/admin-server.js";
import "../imports/server/backup.js";
import "../imports/server/contacts-server.js";
import "../imports/server/core.js";
import "../imports/server/demo-server.js";
import "../imports/server/desktop-notifications-server.js";
import "../imports/server/dev-accounts-server.js";
import "../imports/server/gateway-router.js";
import "../imports/server/grain-server.js";
import "../imports/server/hack-session.js";
import "../imports/server/identity.js";
import "../imports/server/installer.js";
import "../imports/server/install-server.js";
import "../imports/server/notifications-server.js";
import "../imports/server/pre-meteor.js";
import "../imports/server/sandcats.js";
import "../imports/server/scheduled-job.js";
import "../imports/server/shell-server.js";
import "../imports/server/signup-server.js";
import "../imports/server/standalone-server.js";
import "../imports/server/startup.js";
import "../imports/server/stats-server.js";
import "../imports/server/transfers-server.js";

import "../imports/shared/admin.js";
import "../imports/shared/dev-accounts.js";
import "../imports/shared/grain-shared.js";
import "../imports/shared/testing.js";
