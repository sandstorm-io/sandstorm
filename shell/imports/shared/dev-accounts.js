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

import { globalDb } from "/imports/db-deprecated.js";

Accounts.loginServices.dev = {
  isEnabled: function () {
    return globalDb.allowDevAccounts();
  },

  getLoginId: function (identity) {
    return identity.services.dev.name;
  },

  initiateLogin: function (loginId) {
    loginDevAccount(loginId);
    return { oneClick: true };
  },

  loginTemplate: {
    name: "devLoginForm",
    priority: -10, // Put it at the top.
  },
};
