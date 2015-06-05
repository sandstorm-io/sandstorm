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

DEFAULT_SPLASH_DIALOG = "Contact the server admin for an invite " +
  "(or <a href=\"https://sandstorm.io/install/\">install your own</a>).";
DEFAULT_SIGNUP_DIALOG = "You've been invited to join this Sandstorm server!";

Router.map(function () {
  this.route("admin", {
    path: "/admin/:_token?",

    waitOn: function () {
      return [
        Meteor.subscribe("admin", this.params._token),
        Meteor.subscribe("adminToken", this.params._token),
        Meteor.subscribe("adminServiceConfiguration", this.params._token),
        Meteor.subscribe("allUsers", this.params._token)
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
      resetResult(state);
      state.set("configurationServiceName", null);
      state.set("settingsTab", "adminSettings");
      state.set("token", this.params._token);
      this.render();
    }
  });
});

if (Meteor.isClient) {
  AdminToken = new Mongo.Collection("adminToken");  // see Meteor.publish("adminToken")
  Meteor.subscribe("publicAdminSettings");

  var resetResult = function (state) {
    state = state || Iron.controller().state;
    state.set("numSettings", 1);
    state.set("successes", 0);
    state.set("failures", 0);
    state.set("errors", []);
    state.set("fadeAlert", false);
    state.set("successMessage", "Your settings have been saved.");
  };

  Meteor.startup(function () {
    ["github", "google", "emailToken"].forEach(function(loginProvider) {
      Tracker.autorun(function () {
        var setting = Settings.findOne({_id: loginProvider});
        if (setting && setting.value) {
          Accounts.registerService(loginProvider);
        } else {
          Accounts.deregisterService(loginProvider);
        }
      });
    });
  });

  Template.admin.events({
    "click #settings-tab": function (event) {
      var state = Iron.controller().state;
      resetResult(state);
      state.set("settingsTab", "adminSettings");
    },
    "click #users-tab": function (event) {
      var state = Iron.controller().state;
      resetResult(state);
      state.set("settingsTab", "adminUsers");
    },
    "click #invites-tab": function (event) {
      var state = Iron.controller().state;
      resetResult(state);
      state.set("settingsTab", "adminInvites");
    }
  });

  Template.admin.helpers({
    adminTab: function () {
      var state = Iron.controller().state;
      return state.get("settingsTab");
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
    },
    successMessage: function () {
      return Iron.controller().state.get("successMessage");
    },
    settingsActive: function () {
      return Iron.controller().state.get("settingsTab") == "adminSettings";
    },
    usersActive: function () {
      return Iron.controller().state.get("settingsTab") == "adminUsers";
    },
    invitesActive: function () {
      return Iron.controller().state.get("settingsTab") == "adminInvites";
    }
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
  Template.adminSettings.events({
    "click .configure-oauth": function (event) {
      var state = Iron.controller().state;
      state.set("configurationServiceName", event.target.getAttribute("data-servicename"));
    },
    "click .reset-login-tokens": function (event) {
      var state = Iron.controller().state;
      resetResult(state);
      var handleErrorBound = handleError.bind(state);
      Meteor.call("clearResumeTokensForService", this.token,
        event.target.getAttribute("data-servicename"), handleErrorBound);
    },
    "click #admin-settings-send-toggle": function (event) {
      var state = Iron.controller().state;
      state.set("isEmailTestActive", !state.get("isEmailTestActive"));
      return false; // prevent form from submitting
    },
    "click #admin-settings-send-test": function (event) {
      var state = Iron.controller().state;
      resetResult(state);
      var handleErrorBound = handleError.bind(state);
      state.set("successMessage", "Email has been sent.");
      Meteor.call("testSend", this.token, document.getElementById("smptUrl").value,
                  document.getElementById("email-test-to").value, handleErrorBound);
      return false; // prevent form from submitting
    },
    "submit #admin-settings-form": function (event) {
      var state = Iron.controller().state;
      var token = this.token;
      resetResult(state);
      state.set("numSettings", 6);

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
        handleErrorBound(new Meteor.Error(400,
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

  Template.adminSettings.helpers({
    googleEnabled: function () {
      var setting = Settings.findOne({_id: "google"});
      if (setting) {
        return setting.value;
      } else {
        return false;
      }
    },
    githubEnabled: function () {
      var setting = Settings.findOne({_id: "github"});
      if (setting) {
        return setting.value;
      } else {
        return false;
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
    isEmailTestActive: function () {
      return Iron.controller().state.get("isEmailTestActive");
    }
  });

  var updateUser = function (options) {
    var state = Iron.controller().state;
    var token = state.get("token");
    resetResult(state);
    state.set("successMessage", "User has been updated.");
    var handleErrorBound = handleError.bind(state);
    Meteor.call("adminUpdateUser", token, options, handleErrorBound);
  };
  Template.adminUsers.events({
    "change select.user-class": function (event) {
      var value = event.target.selectedOptions[0].value;

      if (value == "admin") {
        updateUser({userId: this._id, signupKey: true, isAdmin: true});
      } else if (value == "invited") {
        updateUser({userId: this._id, signupKey: true, isAdmin: false});
      } else if (value == "guest") {
        updateUser({userId: this._id, signupKey: false, isAdmin: false});
      } else {
        console.error("unrecognized user class");
      }
    },
    "change .is-signedup-checkbox": function (event) {
      // The userid is stored on the the <tr>, which is always 2 nodes up
      var userId = event.target.parentElement.parentElement.getAttribute("data-userid");
    }
  });
  Template.adminUsers.helpers({
    users: function () {
      return Meteor.users.find({}, {sort: {createdAt: 1}});
    },
    userService: function () {
      var services = _.without(Object.keys(this.services), "resume");
      if (services.length === 0) {
        return "dev";
      } else {
        return services[0];
      }
    },
    userName: function () {
      var services = this.services;
      if (services.github) {
        return services.github.username;
      } else if (services.google) {
        return services.google.email;
      } else if (services.emailToken) {
        return services.emailToken.email;
      } else {
        return this.profile.name;
      }
    },
    userIsAdmin: function () {
      return !!this.isAdmin;
    },
    userIsInvited: function () {
      return !this.isAdmin && !!this.signupKey;
    },
    userIsGuest: function () {
      return !this.isAdmin && !this.signupKey;
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
      resetResult(state);
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

  Template.adminInvites.events({
    "click #send": function (event) {
      var state = Iron.controller().state;
      var from = document.getElementById("invite-from").value;
      var list = document.getElementById("invite-emails").value;
      var subject = document.getElementById("invite-subject").value;
      var message = document.getElementById("invite-message").value;

      var sendButton = event.currentTarget;
      sendButton.disabled = true;
      var oldContent = sendButton.textContent;
      sendButton.textContent = "Sending...";

      Meteor.call("sendInvites", state.get("token"), getOrigin(), from, list, subject, message,
                  function (error, results) {
        sendButton.disabled = false;
        sendButton.textContent = oldContent;
        if (error) {
          state.set("inviteMessage", { error: error.toString() });
        } else {
          state.set("inviteMessage", results);
        }
      });
    },

    "click #create": function (event) {
      var state = Iron.controller().state;
      var note = document.getElementById("key-note").value;

      Meteor.call("createSignupKey", state.get("token"), note, function (error, key) {
        if (error) {
          state.set("inviteMessage", { error: error.toString() });
        } else {
          state.set("inviteMessage", {
            url: getOrigin() + Router.routes.signup.path({key: key})
          });
        }
      });
    },

    "click .autoSelect": function (event) {
      event.currentTarget.select();
    },

    "click #retry": function (event) {
      Iron.controller().state.set("inviteMessage", undefined);
    },
  });

  Template.adminInvites.helpers({
    error: function () {
      var res = Iron.controller().state.get("inviteMessage");
      return res && res.error;
    },
    email: function () {
      var me = Meteor.user();
      var email = (me.services && me.services.google && me.services.google.email) ||
                  (me.services && me.services.github && me.services.github.email);
      if (email && me.profile.name) {
        email = me.profile.name + " <" + email + ">";
      }
      email = email || "";
      return email;
    },
    url: function () {
      var res = Iron.controller().state.get("inviteMessage");
      return res && res.url;
    }
  });
}

if (Meteor.isServer) {
  var Fs = Npm.require("fs");
  var SANDSTORM_ADMIN_TOKEN = SANDSTORM_VARDIR + "/adminToken";

  var getSmtpUrl = function () {
    var setting = Settings.findOne({_id: "smtpUrl"});
    if (setting) {
      return setting.value;
    } else {
      return process.env.MAIL_URL;
    }
  };

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
    if (setting && setting.value) {
      Accounts.registerService(serviceName);
    }
  };

  Meteor.startup(function () {
    registerServiceOnStartup("google");
    registerServiceOnStartup("github");
    registerServiceOnStartup("emailToken");
  });

  var checkAuth = function (token) {
    if (!isAdmin() && !tokenIsValid(token)) {
      throw new Meteor.Error(403, "User must be admin or provide a valid token");
    }
  };
  Meteor.methods({
    setAccountSetting: function (token, serviceName, value) {
      checkAuth(token);
      // TODO(someday): currently this relies on the fact that an account is tied to a single
      // identity, and thus has only that entry in "services". This will need to be looked at when
      // multiple login methods/identities are allowed for a single account.
      if (!value && !tokenIsValid(token) && (serviceName in Meteor.user().services)) {
        throw new Meteor.Error(403,
          "You can not disable the login service that your account uses.");
      }

      // Only check configurations for OAuth services.
      var oauthServices = ["google", "github"];
      if (value && (oauthServices.indexOf(serviceName) != -1)) {
        var ServiceConfiguration = Package["service-configuration"].ServiceConfiguration;
        var config = ServiceConfiguration.configurations.findOne({service: serviceName});
        if (!config) {
          throw new Meteor.Error(403, "The " + serviceName +
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
      checkAuth(token);

      Settings.upsert({_id: name}, {$set: {value: value}});
    },
    getSmtpUrl: function (token) {
      checkAuth(token);

      return getSmtpUrl();
    },
    "adminConfigureLoginService": function (token, options) {
      checkAuth(token);

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
      checkAuth(token);

      var query = {};
      query["services." + serviceName] = {$exists: true};
      query["services.resume.loginTokens"] = {$exists: true};
      Meteor.users.update(query, {$set: {"services.resume.loginTokens": []}});
    },
    adminUpdateUser: function (token, userInfo) {
      checkAuth(token);

      var userId = userInfo.userId;
      if (userId === Meteor.userId() && !userInfo.isAdmin) {
        throw new Meteor.Error(403, "User cannot remove admin permissions from itself.");
      }

      Meteor.users.update({_id: userId}, {$set: _.omit(userInfo, ["_id", "userId"])});
    },
    testSend: function (token, smtpUrl, to) {
      checkAuth(token);

      SandstormEmail.send({
        to: to,
        from: "Sandstorm Test <no-reply@" + HOSTNAME + ">",
        subject: "Testing your Sandstorm's SMTP setting",
        text: "Success! Your outgoing SMTP is working.",
        smtpUrl: smtpUrl
      });
    },
    createSignupKey: function (token, note) {
      check(note, String);

      checkAuth(token);

      var key = Random.id();
      SignupKeys.insert({_id: key, used: false, note: note});
      return key;
    },
    sendInvites: function (token, origin, from, list, subject, message) {
      check([origin, from, list, subject, message], [String]);

      checkAuth(token);

      if (!from.trim()) {
        throw new Meteor.Error(403, "Must enter 'from' address.");
      }

      if (!list.trim()) {
        throw new Meteor.Error(403, "Must enter 'to' addresses.");
      }

      this.unblock();

      list = list.split("\n");
      for (var i in list) {
        var email = list[i].trim();

        if (email) {
          var key = Random.id();

          SignupKeys.insert({_id: key, used: false, note: "E-mail invite to " + email,
                             definitelySent: false});
          SandstormEmail.send({
            to: email,
            from: from,
            subject: subject,
            text: message.replace(/\$KEY/g, origin + Router.routes.signup.path({key: key}))
          });
          SignupKeys.update(key, {$set: {definitelySent: true}});
        }
      }

      return { sent: true };
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

  Meteor.publish("allUsers", function (token) {
    if ((this.userId && isAdminById(this.userId)) || tokenIsValid(token)) {
      return Meteor.users.find();
    } else {
      return [];
    }
  });
}
