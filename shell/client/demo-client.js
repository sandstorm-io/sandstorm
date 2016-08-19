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

Template.demo.events({
  "click button.start": function (evt) {
    const displayName = "Demo User";

    const userCallbackFunction = function (err) {
      if (err) {
        window.alert(err);
      } else {
        Router.go("root");
      }
    };

    if (isSignedUpOrDemo()) {
      userCallbackFunction();
    } else {
      Accounts.callLoginMethod({
        methodName: "createDemoUser",
        methodArguments: ["Demo User", null],
        userCallback: userCallbackFunction,
      });
    }
  },
});

Template.appdemo.events({
  "click button.start": function (evt) {
    // When clicking on the createDemoUser button on the app demo,
    // we want to:
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

    // calculate the appId

    // We copy the appId into the scope so the autorun function can access it.
    const appId = this.appId;
    let signingIn = false;

    // TODO(cleanup): Is there a better way to do this? Before multi-identity, we could use the
    //   `userCallback` option of `Accounts.callLoginMethod()`, but now that doesn't work because
    //   it fires too early.
    //
    // Note that we don't use Template.instance().autorun() because the template gets destroyed
    // and recreated during account creation.
    let done = false;
    const handle = Tracker.autorun(function () {
      if (done) return;

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

        // Also mark the user as needing the "How to share access" guided-tour hint.
        const grainsCount = globalDb.currentUserGrains().count();
        if (grainsCount === 0) {
          Meteor._localStorage.setItem("userNeedsShareAccessHint", true);
        }

        // 4. Create new grain and 5. browse to it.
        launchAndEnterGrainByPackageId(packageId);
      }
    });
  },
});

Router.map(function () {
  this.route("demo", {
    path: "/demo",
    waitOn: function () {
      return Meteor.subscribe("credentials");
    },

    data: function () {
      return {
        allowDemo: allowDemo,
        pageTitle: "Demo",
        isDemoUser: isDemoUser(),
      };
    },
  });

  this.route("demoRestart", {
    path: "/demo-restart",
    waitOn: function () {
      return Meteor.subscribe("credentials");
    },

    data: function () {
      Meteor.logout();
      Router.go("demo");
    },
  });
});

Router.map(function () {
  this.route("appdemo", {
    path: "/appdemo/:appId",
    waitOn: function () {
      return Meteor.subscribe("appDemoInfo", this.params.appId);
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

      return {
        allowDemo: allowDemo,
        // For appdemo, we always allow you to start the demo, because
        // the this refers to the app demo, and if a visitor clicks
        // visits /appdemo/:appId once and creates a Demo User
        // account, and then clicks a different /appdemo/:appId URL to
        // demo a different app, we want them to experience the joy of
        // trying the second app.
        shouldShowStartDemo: true,
        appName: appName,
        pageTitle: appName + " Demo on Sandstorm",
        appId: this.params.appId,
        isDemoUser: isDemoUser(),
      };
    },
  });
});
