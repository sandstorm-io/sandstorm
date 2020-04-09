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

import { Meteor } from "meteor/meteor";

import { allowDemo } from "/imports/demo.js";
import { isSafeDemoAppUrl } from "/imports/install.js";
import { globalDb } from "/imports/db-deprecated.js";

Router.map(function () {
  this.route("install", {
    path: "/install/:packageId",

    waitOn: function () {
      return [
        Meteor.subscribe("packageInfo", this.params.packageId),
        Meteor.subscribe("credentials"),
        // We need UserActions and Grains populated so we can check if we need to upgrade them.
        Meteor.subscribe("grainsMenu"),
      ];
    },

    data: function () {
      if (!this.ready() || Meteor.loggingIn()) return;

      const packageId = this.params.packageId;
      const packageUrl = this.params.query && this.params.query.url;
      const handle = new SandstormAppInstall(packageId, packageUrl, globalDb);

      const pkg = Packages.findOne(packageId);
      if (!Meteor.userId()) {
        if (allowDemo && isSafeDemoAppUrl(packageUrl)) {
          if (pkg && pkg.status === "ready") {
            Router.go("appdemo", { appId: pkg.appId }, { replaceState: true });
            return handle;
          } else {
            // continue on and install...
          } // jscs:ignore disallowEmptyBlocks
        } else {
          handle.setError("You must sign in to install packages.");
          return handle;
        }
      } else {
        try {
          // When the user clicks to install an app, the app store is opened in a new tab. When they
          // choose an app in the app store, they are redirected back to Sandstorm. But we'd really
          // like to bring them back to the tab where they clicked "install apps". It turns out we
          // can exploit a terrible feature of the web platform to do this: window.opener is a
          // pointer to the tab which opened this tab, and we can actually reach right into it and
          // call functions in it. So, we redirect the original tab to install the app, then close
          // this one.
          if (globalGrains.getAll().length === 0 &&
              window.opener.location.hostname === window.location.hostname &&
              window.opener.Router) {
            // Work-around for https://bugs.chromium.org/p/chromium/issues/detail?id=596301
            // If we convert the query to a string, we don't hit the bug. Once this issue is fixed
            // we can go back to passing the query object (`this.params.query`).
            const queryCopy = packageUrl ? "url=" + encodeURIComponent(packageUrl) : {};

            window.opener.Router.go("install", { packageId: packageId }, { query: queryCopy });
            window.close();
            return handle;
          }
        } catch (err) {
          // Probably security error because window.opener is in a different domain.
        }

        if (!isSignedUp() && !isDemoUser()) {
          handle.setError("This Sandstorm server requires you to get an invite before installing apps.");
          return handle;
        }
      }

      Meteor.call("ensureInstalled", packageId, packageUrl, false, function (err, result) {
        if (err) {
          console.log(err);
          handle.setError(err.message);
        }
      });

      if (pkg === undefined) {
        if (!packageUrl) {
          handle.setError("Unknown package ID: " + packageId +
                   "\nPerhaps it hasn't been uploaded?");
        }

        return handle;
      }

      if (pkg.status !== "ready") {
        if (pkg.status === "failed") {
          handle.setError(pkg.error);
        }

        return handle;
      }

      // From here on, we know the package is installed in the global store, but we
      // might have some per-user things to attend to.
      if (handle.isInstalled()) {
        // The app is installed, so let's send the user to it!  We use `replaceState` so that if
        // the user clicks "back" they don't just get redirected forward again, but end up back
        // at the app list.
        Router.go("appDetails", { appId: handle.appId() }, { replaceState: true });
      }

      return handle;
    },
  });
});

