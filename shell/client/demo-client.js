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

import { allowDemo } from "/imports/demo.js";

Meteor.loginWithDemo = function (options, callback) {
  Router.go("demo");
  callback();
};
// Note: We intentionally don't register the demo service with Accounts.registerService(); we
//   don't want it to appear in the sign-in drop-down.

window.testExpireDemo = function () {
  Meteor.call("testExpireDemo");
};

Router.map(function () {
  this.route("demo", {
    path: "/demo",
    template: "loading",
    waitOn: function () { return globalSubs; },

    data: function () {
      if (!this.ready()) return;
      if (Meteor.loggingIn()) return;

      if (Meteor.userId() && !globalDb.isDemoUser()) {
        Router.go("root", {}, { replaceState: true });
      }

      Session.set("dismissedInstallHint", true);
      Session.set("globalDemoModal", true);

      if (!Meteor.userId()) {
        Accounts.callLoginMethod({
          methodName: "createDemoUser",
          methodArguments: ["Demo User", null],
          userCallback: function () {
            Router.go("root", {}, { replaceState: true });
          },
        });
      }
    },
  });

  this.route("demoRestart", {
    path: "/demo-restart",
    waitOn: function () {
      return Meteor.subscribe("credentials");
    },

    data: function () {
      Meteor.logout();
      Router.go("demo", {}, { replaceState: true });
    },
  });
});

Router.map(function () {
  this.route("appdemo", {
    path: "/appdemo/:appId",
    template: "loading",
    waitOn: function () {
      return globalSubs.concat([Meteor.subscribe("appDemoInfo", this.params.appId)]);
    },

    onRun: function () {
      // When navigating to the appdemo route, we want to:
      //
      // 1. Create the Demo User if they are not logged in.
      //
      // 2. Log the user in as this Demo User if we created it.
      //
      // 3. Install the chosen app.
      //
      // 4. Create a new grain with this app.
      //
      // 5. Take them into this grain.

      // We copy the appId into the scope so the autorun function can access it.
      const appId = this.params.appId;
      let signingIn = false;

      // TODO(cleanup): Is there a better way to do this? Before multi-identity, we could use the
      //   `userCallback` option of `Accounts.callLoginMethod()`, but now that doesn't work because
      //   it fires too early.
      let done = false;
      const handle = Tracker.autorun(() => {
        if (done) return;
        if (!this.ready()) return;
        if (Meteor.loggingIn()) return;

        if (!isSignedUpOrDemo()) {
          if (!signingIn) {
            signingIn = true;
            // 1. Create the Demo User & 2. Log the user in as this Demo User.
            Accounts.callLoginMethod({
              methodName: "createDemoUser",
              methodArguments: ["Demo User", appId],
            });
          } else {
            return;
          }
        } else {
          // `handle` may not have been assigned yet if this is the first run of the callback.
          // But we definitely don't want the callback to run again. So we have to resort to
          // setting a flag that disables subsequent runs, and then deferring the actual stop. Ick.
          done = true;
          Meteor.defer(function () { handle.stop(); });

          // First, find the package ID, since that is what
          // addUserActions takes. Choose the package ID with
          // highest version number.
          const packageId = Packages.findOne(
            { appId: appId },
            { sort: { "manifest.appVersion": -1 } }
          )._id;

          // 3. Install this app for the user, if needed.
          if (UserActions.find({ appId: appId, userId: Meteor.userId() }).count() == 0) {
            Meteor.call("addUserActions", packageId);
          }

          // 4. Create new grain and 5. browse to it.
          launchAndEnterGrainByPackageId(packageId, { replaceState: true });
        }
      });
    },

    data: function () {
      // find the newest (highest version, so "first" when sorting by
      // inverse order) matching package.
      const thisPackage = Packages.findOne({
        appId: this.params.appId,
      }, {
        sort: { "manifest.appVersion": -1 },
      });

      // In the case that the app requested is not present, we show
      // this string as the app name.
      let appName = "missing package";

      if (thisPackage) {
        appName = SandstormDb.appNameFromPackage(thisPackage);
      }

      Session.set("globalDemoModal", { appdemo: appName });
    },
  });
});
