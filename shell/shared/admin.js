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
var publicAdminSettings = ["google", "github", "emailToken", "splashDialog", "signupDialog",
                           "adminAlert", "adminAlertTime", "adminAlertUrl", "termsUrl",
                           "privacyUrl"];

DEFAULT_SPLASH_DIALOG = "Contact the server admin for an invite " +
  "(or <a href=\"https://sandstorm.io/install/\">install your own</a>).";
DEFAULT_SIGNUP_DIALOG = "You've been invited to join this Sandstorm server!";

var adminRoute = RouteController.extend({
  template: "admin",
  waitOn: function () {
    var subs = [
      Meteor.subscribe("admin", this.params._token),
      Meteor.subscribe("adminServiceConfiguration", this.params._token),
      Meteor.subscribe("allUsers", this.params._token)
    ];
    if (this.params._token) {
      subs.push(Meteor.subscribe("adminToken", this.params._token));
    }
    return subs;
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
    state.set("token", this.params._token);
    this.render();
  }
});

Router.map(function () {
  this.route("adminSettings", {
    path: "/admin/settings/:_token?",
    controller: adminRoute
  });
  this.route("adminUsers", {
    path: "/admin/users/:_token?",
    controller: adminRoute
  });
  this.route("adminStats", {
    path: "/admin/stats/:_token?",
    controller: adminRoute
  });
  this.route("adminLog", {
    path: "/admin/log/:_token?",
    controller: adminRoute
  });
  this.route("adminInvites", {
    path: "/admin/invites/:_token?",
    controller: adminRoute
  });
  this.route("adminCaps", {
    path: "/admin/capabilities/:_token?",
    controller: adminRoute
  });
  this.route("adminAdvanced", {
    path: "/admin/advanced/:_token?",
    controller: adminRoute
  });
  this.route("adminOld", {
    path: "/admin/:_token?",
    action: function () {
      this.redirect("adminSettings", this.params)
    }
  });
});

if (Meteor.isClient) {
  AdminToken = new Mongo.Collection("adminToken");  // see Meteor.publish("adminToken")
  AdminLog = new Meteor.Collection("adminLog");
  Meteor.subscribe("publicAdminSettings");

  var resetResult = function (state) {
    state = state || Iron.controller().state;
    state.set("numSettings", 1);
    state.set("successes", 0);
    state.set("failures", 0);
    state.set("errors", []);
    state.set("fadeAlert", false);
    state.set("successMessage", "Your settings have been saved.");
    state.set("powerboxOfferUrl", null);
  };

  Meteor.startup(function () {
    ["github", "google", "emailToken"].forEach(function(loginProvider) {
      Tracker.autorun(function () {
        var setting = Settings.findOne({_id: loginProvider});
        if (setting && setting.value) {
          Accounts.registerService(loginProvider, globalAccountsUi);
        } else {
          Accounts.deregisterService(loginProvider, globalAccountsUi);
        }
      });
    });
  });

  var getToken = function () {
    var state = Iron.controller().state;
    var token = state.get("token");
    if (!token) {
      return;
    } else {
      return {_token: token};
    }
  };

  Template.admin.helpers({
    adminTab: function () {
      return Router.current().route.getName();
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
      return Router.current().route.getName() == "adminSettings";
    },
    usersActive: function () {
      return Router.current().route.getName() == "adminUsers";
    },
    invitesActive: function () {
      return Router.current().route.getName() == "adminInvites";
    },
    statsActive: function () {
      return Router.current().route.getName() == "adminStats";
    },
    logActive: function () {
      return Router.current().route.getName() == "adminLog";
    },
    capsActive: function () {
      return Router.current().route.getName() == "adminCaps";
    },
    advancedActive: function () {
      return Router.current().route.getName() == "adminAdvanced";
    },
    getToken: getToken
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
    "click .oauth-checkbox": function (event) {
      var state = Iron.controller().state;
      var serviceName = event.target.getAttribute("data-servicename");
      var config = Package["service-configuration"].ServiceConfiguration.configurations.findOne({service: serviceName});

      if (!config && event.target.checked) {
        state.set("configurationServiceName", serviceName);
      }
    },
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
      state.set("numSettings", 4);

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
      return false;
    },
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
    smtpUrl: function () {
      return Iron.controller().state.get("smtpUrl");
    },
    isEmailTestActive: function () {
      return Iron.controller().state.get("isEmailTestActive");
    },
    getToken: getToken
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
        return this.profile && this.profile.name;
      }
    },
    userSignupNote: function () {
      if (this.signupEmail) {
        return this.signupEmail;
      } else if (this.signupNote) {
        return this.signupNote;
      } else {
        return "";
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
    },
    userStorageUsage: function () {
      return (typeof this.storageUsage === "number") ? prettySize(this.storageUsage) : "";
    },
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

      // This is a bit of a hack, but we set the number high so that a success message is never displayed
      state.set("numSettings", 100);

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
      Meteor.call("setAccountSetting", token, serviceName, true, handleErrorBound);
    }
  });

  Template.adminInvites.events({
    "click #send": function (event) {
      var state = Iron.controller().state;
      var from = document.getElementById("invite-from").value;
      var list = document.getElementById("invite-emails").value;
      var subject = document.getElementById("invite-subject").value;
      var message = document.getElementById("invite-message").value;
      var quotaInput = document.getElementById("invite-quota");
      var quota;
      if (quotaInput && quotaInput.value.trim() !== "") {
        quota = parseInt(quotaInput.value);
      }

      var sendButton = event.currentTarget;
      sendButton.disabled = true;
      var oldContent = sendButton.textContent;
      sendButton.textContent = "Sending...";

      Meteor.call("sendInvites", state.get("token"), getOrigin(), from, list, subject, message,
                  quota, function (error, results) {
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
      var quotaInput = document.getElementById("key-quota");
      var quota;
      if (quotaInput && quotaInput.value.trim() !== "") {
        quota = parseInt(quotaInput.value);
      }

      Meteor.call("createSignupKey", state.get("token"), note, quota, function (error, key) {
        if (error) {
          state.set("inviteMessage", { error: error.toString() });
        } else {
          state.set("inviteMessage", {
            url: getOrigin() + Router.routes.signup.path({key: key})
          });
        }
      });
    },

    "click #set-quota-submit": function (event) {
      var state = Iron.controller().state;
      var list = document.getElementById("set-quota-emails").value;
      var quotaInput = document.getElementById("set-quota-quota");
      var quota;
      if (quotaInput && quotaInput.value.trim() !== "") {
        quota = parseInt(quotaInput.value);
      }

      var updateButton = event.currentTarget;
      updateButton.disabled = true;
      var oldContent = updateButton.textContent;
      updateButton.textContent = "Updating...";

      Meteor.call("updateQuotas", state.get("token"), list, quota, function (error, results) {
        updateButton.disabled = false;
        updateButton.textContent = oldContent;
        if (error) {
          state.set("inviteMessage", { error: error.toString() });
        } else {
          document.getElementById("set-quota-emails").value = "";
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
    },
    sent: function () {
      var res = Iron.controller().state.get("inviteMessage");
      return res && res.sent;
    },
  });
  var maybeScrollLog = function() {
    var elem = document.getElementById("adminLog");
    if (elem) {
      // The log already exists. It's about to be updated. Check if it's scrolled to the bottom
      // before the update.
      if (elem.scrollHeight - elem.scrollTop === elem.clientHeight) {
        // Indeed, so we want to scroll it back to the bottom after the update.
        Tracker.afterFlush(function () { scrollLogToBottom(elem); });
      }
    } else {
      // No element exists yet, but it's probably about to be created, in which case we definitely
      // want to scroll it.
      Tracker.afterFlush(function () {
        var elem2 = document.getElementById("adminLog");
        if (elem2) scrollLogToBottom(elem2);
      });
    }
  };

  var scrollLogToBottom = function (elem) {
    elem.scrollTop = elem.scrollHeight;
  };

  Template.adminLog.onCreated(function () {
    var state = Iron.controller().state;
    var token = state.get("token");
    this.subscribe("adminLog", token);
  });
  Template.adminLog.helpers({
    html: function () {
      return AnsiUp.ansi_to_html(AdminLog.find({}, {$sort: {_id: 1}})
              .map(function (entry) { return entry.text; })
              .join(""), {use_classes:true});
    }
  });

  Template.adminCaps.onCreated(function () {
    var state = Iron.controller().state;
    var token = state.get("token");
    this.subscribe("adminApiTokens", token);
  });

  Template.adminCaps.helpers({
    powerboxOfferUrl: function () {
      var state = Iron.controller().state;
      return state.get("powerboxOfferUrl");
    },
    caps: function () {
      return ApiTokens.find({$or: [{"frontendRef.ipNetwork": {$exists: true}},
                                   {"frontendRef.ipInterface": {$exists: true}}]});
    },
    userName: function () {
      var userId = findAdminUserForToken(this);
      var user = Meteor.users.findOne({_id: userId});
      if (!user) {
        return "no user";
      }
      var services = user.services;
      if (services.github) {
        return services.github.username;
      } else if (services.google) {
        return services.google.email;
      } else if (services.emailToken) {
        return services.emailToken.email;
      } else {
        return user.profile.name;
      }
    },
    isDisabled: function () {
      return !this.userId;
    },
    disabled: function () {
      return this.revoked;
    }
  })

  var updateCap = function (capId, value) {
    var state = Iron.controller().state;
    resetResult(state);
    if (!value) {
      state.set("successMessage", "Capability has been re-enabled.");
    } else {
      state.set("successMessage", "Capability has been disabled.");
    }
    var handleErrorBound = handleError.bind(state);
    Meteor.call("adminToggleDisableCap", state.get("token"), capId, value, handleErrorBound)
  }

  Template.adminCaps.events({
    "click #offer-ipnetwork": function (event) {
      var state = Iron.controller().state;
      resetResult(state);
      state.set("successMessage", "IpNetwork webkey created. Look for it in the top bar.");
      Meteor.call("offerIpNetwork", this.token, function (err, webkey) {
        state.set("powerboxOfferUrl", webkey);
        handleError.call(state, err);
      });
      return false; // prevent form from submitting
    },
    "click #offer-ipinterface": function (event) {
      var state = Iron.controller().state;
      resetResult(state);
      state.set("successMessage", "IpInterface webkey created. Look for it in the top bar.");
      Meteor.call("offerIpInterface", this.token, function (err, webkey) {
        state.set("powerboxOfferUrl", webkey);
        handleError.call(state, err);
      });
      return false; // prevent form from submitting
    },
    "click #powerbox-offer-popup-closer": function (event) {
      var state = Iron.controller().state;
      return state.set("powerboxOfferUrl", null);
    },
    "click .disable-cap": function (event) {
      var capId = event.target.getAttribute("data-id");
      var token = ApiTokens.findOne({_id: capId});

      updateCap(capId, !token.revoked);
    },
  });

  Template.adminAdvanced.events({
    "submit #admin-settings-form": function (event) {
      var state = Iron.controller().state;
      var token = this.token;
      resetResult(state);
      state.set("numSettings", 7);

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
      Meteor.call("setSetting", token, "splashDialog", event.target.splashDialog.value, handleErrorBound);
      Meteor.call("setSetting", token, "signupDialog", event.target.signupDialog.value, handleErrorBound);
      Meteor.call("setSetting", token, "termsUrl", event.target.termsUrl.value, handleErrorBound);
      Meteor.call("setSetting", token, "privacyUrl", event.target.privacyUrl.value, handleErrorBound);
      Meteor.call("setSetting", token, "adminAlert", event.target.adminAlert.value, handleErrorBound);
      var alertTimeString = event.target.alertTime.value.trim();
      if (alertTimeString) {
        var alertTime = new Date(alertTimeString);
        if (isNaN(alertTime.getTime())) {
          // Assume only time and not date was set.
          alertTime = new Date(new Date().toLocaleDateString() + " " + alertTimeString);
        }
        if (isNaN(alertTime.getTime())) {
          handleErrorBound(new Meteor.Error(
              400, "Couldn't parse alert time, please be more precise."));
        } else {
          Meteor.call("setSetting", token, "adminAlertTime", alertTime, handleErrorBound);
        }
      } else {
        Meteor.call("setSetting", token, "adminAlertTime", null, handleErrorBound);
      }
      Meteor.call("setSetting", token, "adminAlertUrl", event.target.alertUrl.value, handleErrorBound);
      return false;
    }
  });

  Template.adminAdvanced.helpers({
    splashDialog: function() {
      var setting = Settings.findOne({_id: "splashDialog"});
      return (setting && setting.value) || DEFAULT_SPLASH_DIALOG;
    },
    signupDialog: function() {
      var setting = Settings.findOne({_id: "signupDialog"});
      return (setting && setting.value) || DEFAULT_SIGNUP_DIALOG;
    },
    termsUrl: function() {
      var setting = Settings.findOne({_id: "termsUrl"});
      return setting && setting.value;
    },
    privacyUrl: function() {
      var setting = Settings.findOne({_id: "privacyUrl"});
      return setting && setting.value;
    },
    adminAlert: function() {
      var setting = Settings.findOne({_id: "adminAlert"});
      return (setting && setting.value);
    },
    alertTime: function() {
      var setting = Settings.findOne({_id: "adminAlertTime"});
      if (setting && setting.value) {
        return setting.value.toLocaleDateString() + " " + setting.value.toLocaleTimeString();
      } else {
        return "";
      }
    },
    alertUrl: function() {
      var setting = Settings.findOne({_id: "adminAlertUrl"});
      return (setting && setting.value);
    },
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
    if (token && Fs.existsSync(SANDSTORM_ADMIN_TOKEN)) {
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
      Accounts.registerService(serviceName, globalAccountsUi);
    }
  };

  Meteor.startup(function () {
    registerServiceOnStartup("google");
    registerServiceOnStartup("github");
    registerServiceOnStartup("emailToken");
  });

  var checkAuth = function (token) {
    check(token, Match.OneOf(undefined, null, String));
    if (!isAdmin() && !tokenIsValid(token)) {
      throw new Meteor.Error(403, "User must be admin or provide a valid token");
    }
  };
  Meteor.methods({
    setAccountSetting: function (token, serviceName, value) {
      checkAuth(token);
      check(serviceName, String);
      check(value, Boolean);

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
          throw new Meteor.Error(403, "You must configure the " + serviceName +
            " service before you can enable it. Click the \"configure\" link.");
        }
      }
      Settings.upsert({_id: serviceName}, {$set: {value: value}});
      if (value) {
        Accounts.registerService(serviceName, globalAccountsUi);
      } else {
        Accounts.deregisterService(serviceName, globalAccountsUi);
      }
    },
    setSetting: function (token, name, value) {
      checkAuth(token);
      check(name, String);
      check(value, Match.OneOf(null, String, Date));

      Settings.upsert({_id: name}, {$set: {value: value}});
    },
    getSmtpUrl: function (token) {
      checkAuth(token);

      return getSmtpUrl();
    },
    "adminConfigureLoginService": function (token, options) {
      checkAuth(token);
      check(options, Match.ObjectIncluding({service: String}));

      var ServiceConfiguration = Package["service-configuration"].ServiceConfiguration;

      ServiceConfiguration.configurations.upsert({service: options.service}, options);
    },
    clearAdminToken: function(token) {
      check(token, String);
      if (tokenIsValid(token)) {
        Fs.unlinkSync(SANDSTORM_ADMIN_TOKEN);
        console.log("Admin token deleted.");
      }
    },
    clearResumeTokensForService: function (token, serviceName) {
      checkAuth(token);
      check(serviceName, String);

      var query = {};
      query["services." + serviceName] = {$exists: true};
      query["services.resume.loginTokens"] = {$exists: true};
      Meteor.users.update(query, {$set: {"services.resume.loginTokens": []}});
    },
    adminUpdateUser: function (token, userInfo) {
      checkAuth(token);
      check(userInfo, {
        userId: String,
        signupKey: Boolean,
        isAdmin: Boolean
      });

      var userId = userInfo.userId;
      if (userId === Meteor.userId() && !userInfo.isAdmin) {
        throw new Meteor.Error(403, "User cannot remove admin permissions from itself.");
      }

      Meteor.users.update({_id: userId}, {$set: _.omit(userInfo, ["_id", "userId"])});
    },
    testSend: function (token, smtpUrl, to) {
      checkAuth(token);
      check(smtpUrl, String);
      check(to, String);

      SandstormEmail.send({
        to: to,
        from: "Sandstorm Test <no-reply@" + HOSTNAME + ">",
        subject: "Testing your Sandstorm's SMTP setting",
        text: "Success! Your outgoing SMTP is working.",
        smtpUrl: smtpUrl
      });
    },
    createSignupKey: function (token, note, quota) {
      checkAuth(token);
      check(note, String);
      check(quota, Match.OneOf(undefined, null, Number));

      var key = Random.id();
      var content = {_id: key, used: false, note: note};
      if (typeof quota === "number") content.quota = quota;
      SignupKeys.insert(content);
      return key;
    },
    sendInvites: function (token, origin, from, list, subject, message, quota) {
      checkAuth(token);
      check([origin, from, list, subject, message], [String]);
      check(quota, Match.OneOf(undefined, null, Number));

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

          var content = {_id: key, used: false, note: "E-mail invite to " + email,
                         email: email, definitelySent: false};
          if (typeof quota === "number") content.quota = quota;
          SignupKeys.insert(content);
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
    },
    offerIpNetwork: function (token) {
      checkAuth(token);
      if (!isAdmin()) {
        throw new Meteor.Error(403, "Offering IpNetwork is only allowed for logged in users " +
          "(a token is not sufficient). Please sign in with an admin account");
      }

      var requirements = [{
        userIsAdmin: Meteor.userId()
      }];
      var sturdyRef = waitPromise(saveFrontendRef({ipNetwork: true}, {webkey: null},
                                  requirements)).sturdyRef;
      return ROOT_URL.protocol + "//" + makeWildcardHost("api") + "#" + sturdyRef;
    },
    offerIpInterface: function (token) {
      checkAuth(token);
      if (!isAdmin()) {
        throw new Meteor.Error(403, "Offering IpInterface is only allowed for logged in users " +
          "(a token is not sufficient). Please sign in with an admin account");
      }

      var requirements = [{
        userIsAdmin: Meteor.userId()
      }];
      var sturdyRef = waitPromise(saveFrontendRef({ipInterface: true}, {webkey: null},
                                  requirements)).sturdyRef;
      return ROOT_URL.protocol + "//" + makeWildcardHost("api") + "#" + sturdyRef;
    },
    adminToggleDisableCap: function (token, capId, value) {
      checkAuth(token);
      check(capId, String);
      check(value, Boolean);

      if (value) {
        ApiTokens.update({_id: capId}, {$set: {revoked: true}});
      } else {
        ApiTokens.update({_id: capId}, {$set: {revoked: false}});
      }
    },
    updateQuotas: function (token, list, quota) {
      checkAuth(token);
      check(list, String);
      check(quota, Match.OneOf(undefined, null, Number));

      if (!list.trim()) {
        throw new Meteor.Error(400, "Must enter addresses.");
      }

      list = list.split("\n");
      var invalid = [];
      for (var i in list) {
        var modifier = (typeof quota === "number") ? {$set: {quota: quota}}
                                                   : {$unset: {quota: ""}};
        var n = SignupKeys.update({email: list[i]}, modifier, {multi: true});
        n += Meteor.users.update({signupEmail: list[i]}, modifier, {multi: true});

        if (n < 1) invalid.push(list[i]);
      }

      if (invalid.length > 0) {
        throw new Meteor.Error(404, "These addresses did not map to any user nor invite: " +
            invalid.join(", "));
      }
    }
  });

  var authorizedAsAdmin = function (token, userId) {
    return Match.test(token, Match.OneOf(undefined, null, String)) &&
           ((userId && isAdminById(userId)) || tokenIsValid(token));
  };
  Meteor.publish("admin", function (token) {
    if (!authorizedAsAdmin(token, this.userId)) return [];
    return Settings.find();
  });

  Meteor.publish("adminServiceConfiguration", function (token) {
    if (!authorizedAsAdmin(token, this.userId)) return [];
    return Package['service-configuration'].ServiceConfiguration.configurations.find();
  });

  Meteor.publish("publicAdminSettings", function () {
    return Settings.find({_id: { $in: publicAdminSettings}});
  });

  Meteor.publish("adminToken", function (token) {
    check(token, String);
    this.added("adminToken", "adminToken", {tokenIsValid: tokenIsValid(token)});
    this.ready();
  });

  Meteor.publish("allUsers", function (token) {
    if (!authorizedAsAdmin(token, this.userId)) return [];
    return Meteor.users.find();
  });
  Meteor.publish("activityStats", function (token) {
    if (!authorizedAsAdmin(token, this.userId)) return [];
    return ActivityStats.find();
  });

  Meteor.publish("statsTokens", function (token) {
    if (!authorizedAsAdmin(token, this.userId)) return [];
    return StatsTokens.find();
  });

  Meteor.publish("realTimeStats", function (token) {
    if (!authorizedAsAdmin(token, this.userId)) return [];

    // Last five minutes.
    this.added("realTimeStats", "now", computeStats(new Date(Date.now() - 5*60*1000)));

    // Since last sample.
    var lastSample = ActivityStats.findOne({}, {sort: {timestamp: -1}});
    var lastSampleTime = lastSample ? lastSample.timestamp : new Date(0);
    this.added("realTimeStats", "today", computeStats(lastSampleTime));

    // TODO(someday): Update every few minutes?

    this.ready();
  });
  Meteor.publish("adminLog", function (token) {
    if (!authorizedAsAdmin(token, this.userId)) return [];

    var logfile = SANDSTORM_LOGDIR + "/sandstorm.log";

    var fd = Fs.openSync(logfile, "r");
    var startSize = Fs.fstatSync(fd).size;

    // Start tailing at EOF - 8k.
    var offset = Math.max(0, startSize - 8192);

    var self = this;
    function doTail() {
      for (;;) {
        var buf = new Buffer(Math.max(1024, startSize - offset));
        var n = Fs.readSync(fd, buf, 0, buf.length, offset);
        if (n <= 0) break;
        self.added("adminLog", offset, {text: buf.toString("utf8", 0, n)});
        offset += n;
      }
    }

    // Watch the file for changes.
    var watcher = Fs.watch(logfile, {persistent: false}, Meteor.bindEnvironment(doTail));

    // When the subscription stops, stop watching the file.
    this.onStop(function() {
      watcher.close();
      Fs.closeSync(fd);
    });

    // Read initial 8k tail data immediately.
    doTail();

    // Notify ready.
    this.ready();
  });
  Meteor.publish("adminApiTokens", function (token) {
    if (!authorizedAsAdmin(token, this.userId)) return [];
    return ApiTokens.find({$or: [{"frontendRef.ipNetwork": {$exists: true}},
                                 {"frontendRef.ipInterface": {$exists: true}}]},
                          {fields: {frontendRef: 1, created: 1, requirements: 1, revoked: 1}});
  });
}
