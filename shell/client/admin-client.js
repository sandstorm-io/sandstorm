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

Meteor.subscribe("publicAdminSettings");

const newAdminRoute = RouteController.extend({
  template: "newAdmin",
  waitOn: function () {
    const token = sessionStorage.getItem("setup-token");

    const subs = [
      Meteor.subscribe("admin", token),
      Meteor.subscribe("adminServiceConfiguration", token),
      Meteor.subscribe("featureKey", true, token),
    ];

    return subs;
  },

  data: function () {
    const wildcardHostSeemsBroken = (
      Session.get("alreadyTestedWildcardHost") && !Session.get("wildcardHostWorks")
    );
    const websocketSeemsBroken = (
      Session.get("websocketSeemsBroken")
    );

    const hasSetupToken = !!sessionStorage.getItem("setup-token");

    // Most of the admin panel requires login, but we make a special exception for viewing the
    // system log, since this is important for debugging problems that could be preventing login.
    const isUserPermittedBySetupToken = hasSetupToken &&
        Router.current().route.getName() == "newAdminStatus";

    return {
      isUserPermitted: isAdmin() || isUserPermittedBySetupToken,
      wildcardHostSeemsBroken,
      websocketSeemsBroken,
    };
  },

  action: function () {
    const testWebsocket = function () {
      if (Meteor &&
          Meteor.connection &&
          Meteor.connection._stream &&
          Meteor.connection._stream.socket &&
          Meteor.connection._stream.socket.protocol &&
          Meteor.connection._stream.socket.protocol !== "websocket") {
        Session.set("websocketSeemsBroken", true);
      } else {
        Session.set("websocketSeemsBroken", false);
      }
    };

    const testWildcardHost = function () {
      if (Session.get("alreadyTestedWildcardHost")) {
        return;
      }

      if (Session.get("alreadyBeganTestingWildcardHost")) {
        return;
      }

      Session.set("alreadyBeganTestingWildcardHost", true);

      HTTP.call(
        "GET", "//" + makeWildcardHost("selftest-" + Random.hexString(20)),
        { timeout: 30 * 1000 }, (error, response) => {
          Session.set("alreadyTestedWildcardHost", true);
          let looksGood;
          if (error) {
            looksGood = false;
            console.error("Sandstorm WILDCARD_HOST self-test failed. Details:", error);
            console.log(
              "Look here in the JS console, above or below this text, for further " +
                "details provided by your browser.  starting with selftest-*.");
            console.log(
              "See also docs: https://docs.sandstorm.io/en/latest/administering/faq/#why-do-i-see-an-error-when-i-try-to-launch-an-app-even-when-the-sandstorm-interface-works-fine");
            console.log(
              "Slow DNS or intermittent Internet connectivity can cause this message " +
                "to appear unnecessarily; in that case, reloading the page should make " +
                "it go away.");
          } else {
            if (response.statusCode === 200) {
              looksGood = true;
            } else {
              console.log("Surpring status code from self test domain", response.statusCode);
              looksGood = false;
            }
          }

          Session.set("wildcardHostWorks", looksGood);
        });
    };

    // Run self-tests once.
    Tracker.nonreactive(() => {
      testWildcardHost();
      testWebsocket();
    });

    this.render();
  },
});

Router.map(function () {
  this.route("newAdminRoot", {
    path: "/admin",
    controller: newAdminRoute,
  });
  this.route("newAdminIdentity", {
    path: "/admin/identity",
    controller: newAdminRoute,
  });
  this.route("newAdminEmailConfig", {
    path: "/admin/email",
    controller: newAdminRoute,
  });
  this.route("newAdminUsers", {
    path: "/admin/users",
    controller: newAdminRoute,
  });
  this.route("newAdminUserInvite", {
    path: "/admin/users/invite",
    controller: newAdminRoute,
  });
  this.route("newAdminUserDetails", {
    path: "/admin/users/:userId",
    controller: newAdminRoute,
  });
  this.route("newAdminAppSources", {
    path: "/admin/app-sources",
    controller: newAdminRoute,
  });
  this.route("newAdminPreinstalledApps", {
    path: "/admin/preinstalled-apps",
    controller: newAdminRoute,
  });
  this.route("newAdminMaintenance", {
    path: "/admin/maintenance",
    controller: newAdminRoute,
  });
  this.route("newAdminStatus", {
    path: "/admin/status",
    controller: newAdminRoute,
  });
  this.route("newAdminPersonalization", {
    path: "/admin/personalization",
    controller: newAdminRoute,
  });
  this.route("newAdminNetworkCapabilities", {
    path: "/admin/network-capabilities",
    controller: newAdminRoute,
  });
  this.route("newAdminStats", {
    path: "/admin/stats",
    controller: newAdminRoute,
  });
  this.route("newAdminFeatureKey", {
    path: "/admin/feature-key",
    controller: newAdminRoute,
  });
  this.route("newAdminOrganization", {
    path: "/admin/organization",
    controller: newAdminRoute,
  });
  this.route("newAdminHostingManagement", {
    path: "/admin/hosting-management",
    controller: newAdminRoute,
  });
});
