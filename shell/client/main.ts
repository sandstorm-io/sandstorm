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
// the very first thing that is loaded out of the application client-side.  We
// can shuffle things around and refactor a lot more easily once we've
// crashlanded everything in /imports/.  Eventually, there will be a single file
// under client/ that imports everything in the order Meteor would have.
//
// Eventually, we'll also move packages in here, above the app's primary
// implementation, since packages are loaded first
//
// For more information on Meteor's load order, see
// https://guide.meteor.com/structure.html#load-order

// Load packages that the sandstorm shell depends on before sandstorm itself.

// sandstorm-db.
import "../imports/sandstorm-db/db";
import "../imports/sandstorm-db/profile";

// sandstorm-accounts-packages
import "../imports/sandstorm-accounts-packages/accounts";

// sandstorm-ui-topbar.  Depends on sandstorm-identicons.
import "../imports/sandstorm-ui-topbar/topbar.html";
import "../imports/sandstorm-ui-topbar/topbar";

// sandstorm-ui-powerbox.  Depends on sandstorm-db and sandstorm-ui-topbar
import "../imports/sandstorm-ui-powerbox/powerbox.html";

// blackrock-payments
import "../imports/blackrock-payments/constants";
import "../imports/blackrock-payments/client/billingSettings.html";
import "../imports/blackrock-payments/client/billingPrompt.html";
import "../imports/blackrock-payments/client/payments-api.html";
import "../imports/blackrock-payments/client/billingSettings";
import "../imports/blackrock-payments/client/billingPrompt";
import "../imports/blackrock-payments/client/payments-client";
import "../imports/blackrock-payments/client/payments-api-client";

// Load sandstorm shell.
// Templates come first.
import "../imports/client/accounts/credentials/credentials.html";
import "../imports/client/accounts/email-token/token-templates.html";
import "../imports/client/accounts/account-settings.html";
import "../imports/client/accounts/login-buttons.html";
import "../imports/client/admin/admin.html";
import "../imports/client/admin/app-sources.html";
import "../imports/client/admin/certificates.html";
import "../imports/client/admin/email-config.html";
import "../imports/client/admin/hosting-management.html";
import "../imports/client/admin/login-providers.html";
import "../imports/client/admin/maintenance-message.html";
import "../imports/client/admin/network-capabilities.html";
import "../imports/client/admin/networking.html";
import "../imports/client/admin/organization.html";
import "../imports/client/admin/personalization.html";
import "../imports/client/admin/preinstalled-apps.html";
import "../imports/client/admin/stats.html";
import "../imports/client/admin/system-status.html";
import "../imports/client/admin/user-accounts.html";
import "../imports/client/admin/user-details.html";
import "../imports/client/admin/user-invite.html";
import "../imports/client/apps/app-details.html";
import "../imports/client/apps/applist.html";
import "../imports/client/apps/install.html";
import "../imports/client/billing/billingPromptLocal.html";
import "../imports/client/grain/contact-autocomplete.html";
import "../imports/client/grain/grainlist.html";
import "../imports/client/grain/settings.html";
import "../imports/client/setup-wizard/wizard.html";
import "../imports/client/widgets/widgets.html";
import "../imports/client/changelog.html";
import "../imports/client/desktop-notifications.html";
import "../imports/client/grain.html";
import "../imports/client/notifications.html";
import "../imports/client/powerbox-builtins.html";
import "../imports/client/shell.html";
import "../imports/client/styleguide.html";
import "../imports/client/transfers.html";

// Things that came from client/lib.
import "../imports/client/globals";

// Everything else that came from client/
import "../imports/client/accounts/credentials/credentials-client";
import "../imports/client/accounts/email-token/token-client";
import "../imports/client/accounts/saml/saml-client-pt2";
import "../imports/client/accounts/account-settings";
import "../imports/client/accounts/accounts-testing";
import "../imports/client/accounts/login-buttons-session";
import "../imports/client/accounts/login-buttons";
import "../imports/client/admin/admin-new-client";
import "../imports/client/admin/app-sources-client";
import "../imports/client/admin/certificates-client";
import "../imports/client/admin/email-config-client";
import "../imports/client/admin/hosting-management-client";
import "../imports/client/admin/login-providers";
import "../imports/client/admin/maintenance-message-client";
import "../imports/client/admin/network-capabilities-client";
import "../imports/client/admin/networking-client";
import "../imports/client/admin/organization-client";
import "../imports/client/admin/personalization-client";
import "../imports/client/admin/preinstalled-apps-client";
import "../imports/client/admin/stats-client";
import "../imports/client/admin/system-status-client";
import "../imports/client/admin/user-accounts-client";
import "../imports/client/admin/user-details-client";
import "../imports/client/admin/user-invite-client";
import "../imports/client/apps/app-details-client";
import "../imports/client/apps/applist-client";
import "../imports/client/apps/install-client";
import "../imports/client/billing/billingPromptLocal-client";
import "../imports/client/grain/contact-autocomplete";
import "../imports/client/grain/grainlist-client";
import "../imports/client/grain/settings-client";
import "../imports/client/setup-wizard/wizard";
import "../imports/client/vendor/ansi-up";
import "../imports/client/widgets/widgets-client";
import "../imports/db-deprecated";
import "../imports/client/00-startup";
import "../imports/client/admin-client";
import "../imports/client/demo-client";
import "../imports/client/desktop-notifications-client";
import "../imports/client/dev-accounts-client";
import "../imports/client/grain-client";
import "../imports/client/install-client";
import "../imports/client/notifications-client";
import "../imports/client/powerbox-builtins";
import "../imports/client/shell-client";
import "../imports/client/signup-client";
import "../imports/client/styleguide";
import "../imports/client/transfers-client";

import "../imports/shared/admin";
import "../imports/shared/dev-accounts";
import "../imports/shared/grain-shared";

import "../imports/client/testing";
