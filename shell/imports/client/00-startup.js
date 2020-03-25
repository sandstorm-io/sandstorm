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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/pwa-service-worker.js')
  })
}

import AccountsUi from "/imports/client/accounts/accounts-ui.js";
import { GrainViewList } from "/imports/client/grain/grainview-list.js";

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

forceReplica = function (replica) {
  // Helper function for blackrock debugging.
  document.cookie = "force_replica=" + replica + ";path=/;domain=." + window.location.hostname;
};
