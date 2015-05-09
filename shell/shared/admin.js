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

var ADMIN_TOKEN_EXPIRATION_TIME = 15 * 60 * 1000;
var publicAdminSettings = ["google", "github", "emailToken", "splashDialog", "signupDialog"];

DEFAULT_SPLASH_DIALOG = "Contact the server admin for an invite.";
DEFAULT_SIGNUP_DIALOG = "You've been invited to join this Sandstorm server!";

Router.map(function () {
  this.route("admin", {
    path: "/admin/:_token?",

    waitOn: function () {
      return [
        Meteor.subscribe("admin", this.params._token),
        Meteor.subscribe("adminToken", this.params._token),
        Meteor.subscribe("adminServiceConfiguration", this.params._token)
      ];
    },

    data: function () {
      var adminToken = AdminToken.findOne();
      return {
        settings: Settings.find(),
        token: this.params._token,
        isUserPermitted: isAdmin() || (adminToken && adminToken.tokenIsValid)
      };
    },

    action: function () {
      var state = this.state;
      Meteor.call("getSmtpUrl", this.params._token, function(error, result){
        state.set("smtpUrl", result);
      });
      state.set("numSettings", 1);
      state.set("successes", 0);
      state.set("failures", 0);
      state.set("errors", []);
      state.set("fadeAlert", false);
      state.set("configurationServiceName", null);
      this.render();
    }
  });
});

if (Meteor.isClient) {
  AdminToken = new Mongo.Collection("adminToken");  // see Meteor.publish("adminToken")
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
    var state = this;
    Meteor.setTimeout(function () {
      state.set("fadeAlert", true);
    }, 3000);
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

  var successTracker;
  Template.admin.events({
    "click .configure-oauth": function (event) {
      var state = Iron.controller().state;
      state.set("configurationServiceName", event.target.getAttribute("data-servicename"));
    },
    "click .reset-login-tokens": function (event) {
      var state = Iron.controller().state;
      state.set("numSettings", 1);
      state.set("successes", 0);
      state.set("failures", 0);
      state.set("errors", []);
      state.set("fadeAlert", false);
      var handleErrorBound = handleError.bind(state);
      Meteor.call("clearResumeTokensForService", this.token,
        event.target.getAttribute("data-servicename"), handleErrorBound);
    },
    "submit #admin-settings-form": function (event) {
      var state = Iron.controller().state;
      var token = this.token;
      state.set("numSettings", 6);
      state.set("successes", 0);
      state.set("failures", 0);
      state.set("errors", []);
      state.set("fadeAlert", false);

      if (successTracker) {
        successTracker.stop();
        successTracker = null;
      }
      if (token) {
        successTracker = Tracker.autorun(function () {
          if (state.get("successes") == state.get("numSettings")) {
            Meteor.call("clearAdminToken", token, function (err) {
              if (err) {
                console.error("Failed to clear admin token: ", err);
              }
            });
          }
        });
      }
      var handleErrorBound = handleError.bind(state);
      if (event.target.emailTokenLogin.checked && !event.target.smtpUrl.value) {
        handleErrorBound(new Meteor.Error(400, "Bad Request",
            "You must configure an SMTP server to use email login."));
        return false;
      }
      Meteor.call("setAccountSetting", token, "google", event.target.googleLogin.checked, handleErrorBound);
      Meteor.call("setAccountSetting", token, "github", event.target.githubLogin.checked, handleErrorBound);
      Meteor.call("setAccountSetting", token, "emailToken", event.target.emailTokenLogin.checked, handleErrorBound);
      Meteor.call("setSetting", token, "smtpUrl", event.target.smtpUrl.value, handleErrorBound);
      Meteor.call("setSetting", token, "splashDialog", event.target.splashDialog.value, handleErrorBound);
      Meteor.call("setSetting", token, "signupDialog", event.target.signupDialog.value, handleErrorBound);

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
      var state = Iron.controller().state;
      return state.get("successes") == state.get("numSettings");
    },
    failure: function () {
      return Iron.controller().state.get("failures");
    },
    errors: function () {
      return Iron.controller().state.get("errors");
    },
    fadeAlert: function () {
      return Iron.controller().state.get("fadeAlert");
    }
  });

  var configureLoginServiceDialogTemplateForService = function (serviceName) {
    return Template['configureLoginServiceDialogFor' + capitalize(serviceName)];
  };

  var configurationFields = function (serviceName) {
    var template = configureLoginServiceDialogTemplateForService(serviceName);
    return template ? template.fields() : [];
  };

  Template._adminConfigureLoginServiceDialog.helpers({
    configurationFields: function () {
      var serviceName = Iron.controller().state.get("configurationServiceName");
      var configurations = Package['service-configuration'].ServiceConfiguration.configurations;
      var configuration = configurations.findOne({service: serviceName});
      var fields = configurationFields(serviceName);
      if (configuration) {
        return _.map(fields, function (field) {
          field.value = configuration[field.property];
          return field;
        });
      } else {
        return fields;
      }
    },
    visible: function () {
      return Iron.controller().state.get("configurationServiceName") !== null;
    },
    configurationSteps: function () {
      // renders the appropriate template
      return configureLoginServiceDialogTemplateForService(
        Iron.controller().state.get("configurationServiceName"));
    }
  });

  var capitalize = function(str){
    return str.charAt(0).toUpperCase() + str.slice(1);
  };

  Template._adminConfigureLoginServiceDialog.events({
    'click .configure-login-service-dismiss-button': function () {
      Iron.controller().state.set("configurationServiceName", null);
    },
    'click #configure-login-service-dialog-save-configuration': function () {
      var state = Iron.controller().state;
      state.set("numSettings", 1);
      state.set("successes", 0);
      state.set("failures", 0);
      state.set("errors", []);
      state.set("fadeAlert", false);
      var handleErrorBound = handleError.bind(state);
      var serviceName = state.get("configurationServiceName");
      var token = this.token;
      var configuration = {
        service: serviceName
      };

      // Fetch the value of each input field
      _.each(configurationFields(serviceName), function(field) {
        configuration[field.property] = document.getElementById(
          'configure-login-service-dialog-' + field.property).value.trim()
      });

      configuration.loginStyle = "redirect";

      Meteor.call("adminConfigureLoginService", token, configuration, function (err) {
        handleErrorBound(err);
        state.set("configurationServiceName", null);
      });
    }
  });
}

if (Meteor.isServer) {
  var Fs = Npm.require("fs");
  var SANDSTORM_ADMIN_TOKEN = SANDSTORM_VARDIR + "/adminToken";

  var tokenIsValid = function(token) {
    if (Fs.existsSync(SANDSTORM_ADMIN_TOKEN)) {
      var stats = Fs.statSync(SANDSTORM_ADMIN_TOKEN);
      var expireTime = new Date(Date.now() - ADMIN_TOKEN_EXPIRATION_TIME);
      if (stats.mtime < expireTime) {
        return false;
      } else {
        return Fs.readFileSync(SANDSTORM_ADMIN_TOKEN, {encoding: "utf8"}) === token;
      }
    } else {
      return false;
    }
  };

  var registerServiceOnStartup = function (serviceName) {
    var setting = Settings.findOne({_id: serviceName});
    if ((!setting && (serviceName === "github" || serviceName === "google")) ||
        (setting && setting.value)) {
      Accounts.registerService(serviceName);
    }
  };

  var updateLoginStyleToRedirect = function (serviceName) {
    var configurations = Package["service-configuration"].ServiceConfiguration.configurations;
    var config = configurations.findOne({service: serviceName});

    if (config && config.loginStyle !== "redirect") {
      configurations.update({service: serviceName}, {$set: {loginStyle: "redirect"}});
    }
  };

  Meteor.startup(function () {
    registerServiceOnStartup("google");
    registerServiceOnStartup("github");
    registerServiceOnStartup("emailToken");

    updateLoginStyleToRedirect("google");
    updateLoginStyleToRedirect("github");
  });

  Meteor.methods({
    setAccountSetting: function (token, serviceName, value) {
      if (!isAdmin() && !tokenIsValid(token)) {
        throw new Meteor.Error(403, "Unauthorized", "User must be admin or provide a valid token");
      }

      // TODO(someday): currently this relies on the fact that an account is tied to a single
      // identity, and thus has only that entry in "services". This will need to be looked at when
      // multiple login methods/identities are allowed for a single account.
      if (!value && !tokenIsValid(token) && (serviceName in Meteor.user().services)) {
        throw new Meteor.Error(403, "Unauthorized",
          "You can not disable the login service that your account uses.");
      }

      // Only check configurations for OAuth services.
      // TODO(someday): check a list instead of just filtering out "emailToken"
      if (value && serviceName !== "emailToken") {
        var ServiceConfiguration = Package["service-configuration"].ServiceConfiguration;
        var config = ServiceConfiguration.configurations.findOne({service: serviceName});
        if (!config) {
          throw new Meteor.Error(403, "Unauthorized", "The " + serviceName +
            " service is not configured, and so cannot be enabled.");
        }
      }
      Settings.upsert({_id: serviceName}, {$set: {value: value}});
      if (value) {
        Accounts.registerService(serviceName);
      } else {
        Accounts.deregisterService(serviceName);
      }
    },
    setSetting: function (token, name, value) {
      if (!isAdmin() && !tokenIsValid(token)) {
        throw new Meteor.Error(403, "Unauthorized", "User must be admin or provide a valid token");
      }

      Settings.upsert({_id: name}, {$set: {value: value}});
    },
    getSmtpUrl: function (token) {
      if (!isAdmin() && !tokenIsValid(token)) {
        throw new Meteor.Error(403, "Unauthorized", "User must be admin or provide a valid token");
      }

      return getSmtpUrl();
    },
    "adminConfigureLoginService": function (token, options) {
      if (!isAdmin() && !tokenIsValid(token)) {
        throw new Meteor.Error(403, "Unauthorized", "User must be admin");
      }

      var ServiceConfiguration = Package["service-configuration"].ServiceConfiguration;

      ServiceConfiguration.configurations.upsert({service: options.service}, options);
    },
    clearAdminToken: function(token) {
      if (tokenIsValid(token)) {
        Fs.unlinkSync(SANDSTORM_ADMIN_TOKEN);
        console.log("Admin token deleted.");
      }
    },
    clearResumeTokensForService: function (token, serviceName) {
      if (!isAdmin() && !tokenIsValid(token)) {
        throw new Meteor.Error(403, "Unauthorized", "User must be admin");
      }

      var query = {};
      query["services." + serviceName] = {$exists: true};
      query["services.resume.loginTokens"] = {$exists: true};
      Meteor.users.update(query, {$set: {"services.resume.loginTokens": []}});
    }
  });

  Meteor.publish("admin", function (token) {
    if ((this.userId && isAdminById(this.userId)) || tokenIsValid(token)) {
      return Settings.find();
    } else {
      return [];
    }
  });

  Meteor.publish("adminServiceConfiguration", function (token) {
    if ((this.userId && isAdminById(this.userId)) || tokenIsValid(token)) {
      return Package['service-configuration'].ServiceConfiguration.configurations.find();
    } else {
      return [];
    }
  });

  Meteor.publish("publicAdminSettings", function () {
    return Settings.find({_id: { $in: publicAdminSettings}});
  });

  Meteor.publish("adminToken", function (token) {
    this.added("adminToken", "adminToken", {tokenIsValid: tokenIsValid(token)});
    this.ready();
  });
}
