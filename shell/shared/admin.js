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

var NUM_SETTINGS = 6;
var publicAdminSettings = ["google", "github", "emailToken", "splashDialog", "signupDialog"];

DEFAULT_SPLASH_DIALOG = "Contact the server admin for an invite.";
DEFAULT_SIGNUP_DIALOG = "You've been invited to join this Sandstorm server!";

Router.map(function () {
  this.route("admin", {
    path: "/admin",

    waitOn: function () {
      return [
        Meteor.subscribe("admin")
      ];
    },

    data: function () {
      return {
        settings: Settings.find()
      };
    },

    action: function () {
      var state = this.state;
      Meteor.call("getSmtpUrl", function(error, result){
        state.set("smtpUrl", result);
      });
      state.set("successes", 0);
      state.set("failures", 0);
      state.set("errors", []);
      this.render();
    }
  });
});

if (Meteor.isClient) {
  Meteor.subscribe("publicAdminSettings");

  Meteor.startup(function () {
    Tracker.autorun(function () {
      var setting = Settings.findOne({_id: "github"});
      if (!setting || setting.value) {
        Accounts.registerService("github");
      } else if (!setting.value) {
        Accounts.deregisterService("github");
      }
    });

    Tracker.autorun(function () {
      var setting = Settings.findOne({_id: "google"});
      if (!setting || setting.value) {
        Accounts.registerService("google");
      } else if (!setting.value) {
        Accounts.deregisterService("google");
      }
    });

    Tracker.autorun(function () {
      var setting = Settings.findOne({_id: "emailToken"});
      if (setting && setting.value) {
        Accounts.registerService("emailToken");
      } else {
        Accounts.deregisterService("emailToken");
      }
    });
  });

  var handleError = function (err) {
    if (err) {
      this.set("failures", this.get("failures") + 1);
      console.error(err);
      var errors = this.get("errors");
      errors.push(err);
      this.set("errors", errors);
    } else {
      this.set("successes", this.get("successes") + 1);
    }
  };

  Template.admin.events({
    "submit #admin-settings-form": function (event) {
      var state = Iron.controller().state;
      state.set("successes", 0);
      state.set("failures", 0);
      state.set("errors", []);
      var handleErrorBound = handleError.bind(state);
      if (event.target.emailTokenLogin.checked && !event.target.smtpUrl.value) {
        handleErrorBound(new Meteor.Error(400, "Bad Request",
            "You must configure an SMTP server to use email login."));
        return false;
      }
      Meteor.call("setAccountSetting", "google", event.target.googleLogin.checked, handleErrorBound);
      Meteor.call("setAccountSetting", "github", event.target.githubLogin.checked, handleErrorBound);
      Meteor.call("setAccountSetting", "emailToken", event.target.emailTokenLogin.checked, handleErrorBound);
      Meteor.call("setSetting", "smtpUrl", event.target.smtpUrl.value, handleErrorBound);
      Meteor.call("setSetting", "splashDialog", event.target.splashDialog.value, handleErrorBound);
      Meteor.call("setSetting", "signupDialog", event.target.signupDialog.value, handleErrorBound);

      return false;
    }
  });

  Template.admin.helpers({
    googleEnabled: function () {
      var setting = Settings.findOne({_id: "google"});
      if (setting) {
        return setting.value;
      } else {
        return true;
      }
    },
    githubEnabled: function () {
      var setting = Settings.findOne({_id: "github"});
      if (setting) {
        return setting.value;
      } else {
        return true;
      }
    },
    emailTokenEnabled: function () {
      var setting = Settings.findOne({_id: "emailToken"});
      if (setting) {
        return setting.value;
      } else {
        return false;
      }
    },
    splashDialog: function() {
      var setting = Settings.findOne({_id: "splashDialog"});
      return (setting && setting.value) || DEFAULT_SPLASH_DIALOG;
    },
    signupDialog: function() {
      var setting = Settings.findOne({_id: "signupDialog"});
      return (setting && setting.value) || DEFAULT_SIGNUP_DIALOG;
    },
    smtpUrl: function () {
      return Iron.controller().state.get("smtpUrl");
    },
    success: function () {
      return Iron.controller().state.get("successes") == NUM_SETTINGS;
    },
    failure: function () {
      return Iron.controller().state.get("failures");
    },
    errors: function () {
      return Iron.controller().state.get("errors");
    }
  });
}

if (Meteor.isServer) {
  var registerServiceOnStartup = function (serviceName) {
    var setting = Settings.findOne({_id: serviceName});
    if ((!setting && (serviceName === "github" || serviceName === "google")) ||
        (setting && setting.value)) {
      Accounts.registerService(serviceName);
    }
  };
  Meteor.startup(function () {
    registerServiceOnStartup("google");
    registerServiceOnStartup("github");
    registerServiceOnStartup("emailToken");
  });

  Meteor.methods({
    setAccountSetting: function (serviceName, value) {
      if (!isAdmin()) {
        throw new Meteor.Error(403, "Unauthorized", "User must be admin");
      }

      var setting = Settings.findOne({_id: serviceName});
      Settings.upsert({_id: serviceName}, {$set: {value: value}});
      if (value) {
        Accounts.registerService(serviceName);
      } else {
        Accounts.deregisterService(serviceName);
      }
    },
    setSetting: function (name, value) {
      if (!isAdmin()) {
        throw new Meteor.Error(403, "Unauthorized", "User must be admin");
      }

      Settings.upsert({_id: name}, {$set: {value: value}});
    },
    getSmtpUrl: function (name, value) {
      if (!isAdmin()) {
        throw new Meteor.Error(403, "Unauthorized", "User must be admin");
      }

      return getSmtpUrl();
    }
  });

  Settings.allow({
    insert: function (userId) {
      return isAdminById(userId);
    },
    update: function (userId) {
      return isAdminById(userId);
    }
  });

  Meteor.publish("admin", function () {
    if (this.userId && isAdminById(this.userId)) {
      return Settings.find();
    } else {
      return [];
    }
  });

  Meteor.publish("publicAdminSettings", function () {
    return Settings.find({_id: { $in: publicAdminSettings}});
  });
}
