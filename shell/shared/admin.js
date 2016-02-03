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

const ADMIN_TOKEN_EXPIRATION_TIME = 15 * 60 * 1000;
const publicAdminSettings = [
  "google", "github", "emailToken", "splashUrl", "signupDialog",
  "adminAlert", "adminAlertTime", "adminAlertUrl", "termsUrl",
  "privacyUrl", "appMarketUrl", "appIndexUrl", "appUpdatesEnabled",
  "serverTitle", "returnAddress",
];

DEFAULT_SIGNUP_DIALOG = "You've been invited to join this Sandstorm server!";

const adminRoute = RouteController.extend({
  template: "admin",
  waitOn: function () {
    const subs = [
      Meteor.subscribe("admin", this.params._token),
      Meteor.subscribe("adminServiceConfiguration", this.params._token),
    ];
    if (this.params._token) {
      subs.push(Meteor.subscribe("adminToken", this.params._token));
    }

    return subs;
  },

  data: function () {
    const adminToken = AdminToken.findOne();
    return {
      settings: Settings.find(),
      token: this.params._token,
      isUserPermitted: isAdmin() || (adminToken && adminToken.tokenIsValid),
    };
  },

  action: function () {
    // Test the WILDCARD_HOST for sanity.
    Tracker.nonreactive(() => {
      if (Session.get("alreadyTestedWildcardHost")) {
        return;
      }

      HTTP.call("GET", "//" + makeWildcardHost("selftest-" + Random.hexString(20)),
                { timeout: 2000 }, (error, response) => {
                  Session.set("alreadyTestedWildcardHost", true);
                  let looksGood;
                  if (error) {
                    looksGood = false;
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
    });

    const state = this.state;
    Meteor.call("getSmtpUrl", this.params._token, function (error, result) {
      state.set("smtpUrl", result);
    });

    const user = Meteor.user();
    if (user && user.loginIdentities) {
      if (this.params._token) {
        if (!user.signupKey || !user.isAdmin) {
          Meteor.call("signUpAsAdmin", this.params._token);
        } else if (user.isAdmin) {
          // We don't need the token. Redirect to the current route, minus the token parameter.
          Router.go(this.route.getName(), {}, _.pick(this.params, "query", "hash"));
        }
      }
    }

    resetResult(state);
    state.set("configurationServiceName", null);
    state.set("token", this.params._token);
    this.render();
  },
});

Router.map(function () {
  this.route("adminSettings", {
    path: "/admin/settings/:_token?",
    controller: adminRoute,
  });
  this.route("adminUsers", {
    path: "/admin/users/:_token?",
    controller: adminRoute,
  });
  this.route("adminStats", {
    path: "/admin/stats/:_token?",
    controller: adminRoute,
  });
  this.route("adminLog", {
    path: "/admin/log/:_token?",
    controller: adminRoute,
  });
  this.route("adminInvites", {
    path: "/admin/invites/:_token?",
    controller: adminRoute,
  });
  this.route("adminCaps", {
    path: "/admin/capabilities/:_token?",
    controller: adminRoute,
  });
  this.route("adminAdvanced", {
    path: "/admin/advanced/:_token?",
    controller: adminRoute,
  });
  this.route("adminOld", {
    path: "/admin/:_token?",
    action: function () {
      this.redirect("adminSettings", this.params);
    },
  });
});

if (Meteor.isClient) {
  AdminToken = new Mongo.Collection("adminToken");  // see Meteor.publish("adminToken")
  AdminLog = new Meteor.Collection("adminLog");
  Meteor.subscribe("publicAdminSettings");

  const resetResult = function (state) {
    state = state || Iron.controller().state;
    state.set("numSettings", 1);
    state.set("successes", 0);
    state.set("failures", 0);
    state.set("errors", []);
    state.set("fadeAlert", false);
    state.set("successMessage", "Your settings have been saved.");
    state.set("powerboxOfferUrl", null);
  };

  const getToken = function () {
    const state = Iron.controller().state;
    const token = state.get("token");
    if (!token) {
      return;
    } else {
      return { _token: token };
    }
  };

  Template.admin.helpers({
    adminTab: function () {
      return Router.current().route.getName();
    },

    success: function () {
      const state = Iron.controller().state;
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

    wildcardHostSeemsBroken: function () {
      if (Session.get("alreadyTestedWildcardHost") &&
          !Session.get("wildcardHostWorks")) {
        return true;
      }

      return false;
    },

    getToken: getToken,
  });

  const handleError = function (err) {
    const _this = this;
    Meteor.setTimeout(() => {
      _this.set("fadeAlert", true);
    }, 3000);

    if (err) {
      this.set("failures", this.get("failures") + 1);
      console.error(err);
      const errors = this.get("errors");
      errors.push(err);
      this.set("errors", errors);
    } else {
      this.set("successes", this.get("successes") + 1);
    }
  };

  Template.adminSettings.events({
    "click .oauth-checkbox": function (event) {
      const state = Iron.controller().state;
      const serviceName = event.target.getAttribute("data-servicename");
      const config = Package["service-configuration"].ServiceConfiguration.configurations.findOne({ service: serviceName });

      const setting = Settings.findOne({ _id: serviceName });
      if (event.target.checked && (!config || (setting && setting.automaticallyReset))) {
        state.set("configurationServiceName", serviceName);
      }
    },

    "click .configure-oauth": function (event) {
      const state = Iron.controller().state;
      state.set("configurationServiceName", event.target.getAttribute("data-servicename"));
    },

    "click .reset-login-tokens": function (event) {
      const state = Iron.controller().state;
      resetResult(state);
      const handleErrorBound = handleError.bind(state);
      Meteor.call("clearResumeTokensForService", this.token,
        event.target.getAttribute("data-servicename"), handleErrorBound);
    },

    "click #admin-settings-send-toggle": function (event) {
      const state = Iron.controller().state;
      state.set("isEmailTestActive", !state.get("isEmailTestActive"));
      return false; // prevent form from submitting
    },

    "click #admin-settings-send-test": function (event) {
      const state = Iron.controller().state;
      resetResult(state);
      const handleErrorBound = handleError.bind(state);
      state.set("successMessage", "Email has been sent.");
      Meteor.call("testSend", this.token, document.getElementById("smptUrl").value,
                  document.getElementById("email-test-to").value, handleErrorBound);
      return false; // prevent form from submitting
    },

    "submit #admin-settings-form": function (event) {
      const state = Iron.controller().state;
      const token = this.token;
      resetResult(state);
      state.set("numSettings", 4);

      const handleErrorBound = handleError.bind(state);
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
    setDocumentTitle: function () {
      document.title = "Settings · Admin · " + globalDb.getServerTitle();
    },

    googleSetting: function () {
      return Settings.findOne({ _id: "google" });
    },

    githubSetting: function () {
      return Settings.findOne({ _id: "github" });
    },

    emailTokenEnabled: function () {
      const setting = Settings.findOne({ _id: "emailToken" });
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

    getToken: getToken,
  });

  const updateUser = function (options) {
    const state = Iron.controller().state;
    const token = state.get("token");
    resetResult(state);
    state.set("successMessage", "User has been updated.");
    const handleErrorBound = handleError.bind(state);
    Meteor.call("adminUpdateUser", token, options, handleErrorBound);
  };

  Template.adminUsers.onCreated(function () {
    const state = Iron.controller().state;
    const token = state.get("token");
    // TODO(perf): Paginate.
    this.subscribe("allUsers", token);
  });

  Template.adminUsers.events({
    "change select.user-class": function (event) {
      const value = event.target.selectedOptions[0].value;

      if (value == "admin") {
        updateUser({ userId: this._id, signupKey: true, isAdmin: true });
      } else if (value == "invited") {
        updateUser({ userId: this._id, signupKey: true, isAdmin: false });
      } else if (value == "guest") {
        updateUser({ userId: this._id, signupKey: false, isAdmin: false });
      } else {
        console.error("unrecognized user class");
      }
    },

    "change .is-signedup-checkbox": function (event) {
      // The userid is stored on the the <tr>, which is always 2 nodes up
      const userId = event.target.parentElement.parentElement.getAttribute("data-userid");
    },
  });
  Template.adminUsers.helpers({
    setDocumentTitle: function () {
      document.title = "Users · Admin · " + globalDb.getServerTitle();
    },

    users: function () {
      return Meteor.users.find({ loginIdentities: { $exists: 1 } }, { sort: { createdAt: 1 } });
    },

    userIdentity: function () {
      const identityId = SandstormDb.getUserIdentityIds(this)[0];
      const identity = Meteor.users.findOne({ _id: identityId });
      if (identity) {
        SandstormDb.fillInProfileDefaults(identity);
        SandstormDb.fillInIntrinsicName(identity);
        return identity;
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

  const configureLoginServiceDialogTemplateForService = function (serviceName) {
    return Template["configureLoginServiceDialogFor" + capitalize(serviceName)];
  };

  const configurationFields = function (serviceName) {
    const template = configureLoginServiceDialogTemplateForService(serviceName);
    return template ? template.fields() : [];
  };

  Template._adminConfigureLoginServiceDialog.helpers({
    configurationFields: function () {
      const serviceName = Iron.controller().state.get("configurationServiceName");
      const configurations = Package["service-configuration"].ServiceConfiguration.configurations;
      const configuration = configurations.findOne({ service: serviceName });
      const fields = configurationFields(serviceName);
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
    },
  });

  const capitalize = function (str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  };

  Template._adminConfigureLoginServiceDialog.events({
    "click .configure-login-service-dismiss-button": function () {
      Iron.controller().state.set("configurationServiceName", null);
    },

    "click #configure-login-service-dialog-save-configuration": function () {
      const state = Iron.controller().state;
      resetResult(state);

      // This is a bit of a hack, but we set the number high so that a success message is never displayed
      state.set("numSettings", 100);

      const handleErrorBound = handleError.bind(state);
      const serviceName = state.get("configurationServiceName");
      const token = this.token;
      const configuration = {
        service: serviceName,
      };

      // Fetch the value of each input field
      _.each(configurationFields(serviceName), function (field) {
        configuration[field.property] = document.getElementById(
          "configure-login-service-dialog-" + field.property).value.trim();
      });

      configuration.loginStyle = "redirect";

      Meteor.call("adminConfigureLoginService", token, configuration, function (err) {
        handleErrorBound(err);
        state.set("configurationServiceName", null);
      });

      Meteor.call("setAccountSetting", token, serviceName, true, handleErrorBound);
    },
  });

  Template.adminInvites.events({
    "click #send": function (event) {
      const state = Iron.controller().state;
      const from = document.getElementById("invite-from").value;
      const list = document.getElementById("invite-emails").value;
      const subject = document.getElementById("invite-subject").value;
      const message = document.getElementById("invite-message").value;
      const quotaInput = document.getElementById("invite-quota");
      let quota;
      if (quotaInput && quotaInput.value.trim() !== "") {
        quota = parseInt(quotaInput.value);
      }

      const sendButton = event.currentTarget;
      sendButton.disabled = true;
      const oldContent = sendButton.textContent;
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
      const state = Iron.controller().state;
      const note = document.getElementById("key-note").value;
      const quotaInput = document.getElementById("key-quota");
      let quota;
      if (quotaInput && quotaInput.value.trim() !== "") {
        quota = parseInt(quotaInput.value);
      }

      Meteor.call("createSignupKey", state.get("token"), note, quota, function (error, key) {
        if (error) {
          state.set("inviteMessage", { error: error.toString() });
        } else {
          state.set("inviteMessage", {
            url: getOrigin() + Router.routes.signup.path({ key: key }),
          });
        }
      });
    },

    "click #set-quota-submit": function (event) {
      const state = Iron.controller().state;
      const list = document.getElementById("set-quota-emails").value;
      const quotaInput = document.getElementById("set-quota-quota");
      let quota;
      if (quotaInput && quotaInput.value.trim() !== "") {
        quota = parseInt(quotaInput.value);
      }

      const updateButton = event.currentTarget;
      updateButton.disabled = true;
      const oldContent = updateButton.textContent;
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
    setDocumentTitle: function () {
      document.title = "Invites · Admin · " + globalDb.getServerTitle();
    },

    error: function () {
      const res = Iron.controller().state.get("inviteMessage");
      return res && res.error;
    },

    email: function () {
      const me = Meteor.user();
      let email = (me.services && me.services.google && me.services.google.email) ||
                  (me.services && me.services.github && me.services.github.email);
      if (email && me.profile.name) {
        email = me.profile.name + " <" + email + ">";
      }

      email = email || "";
      return email;
    },

    url: function () {
      const res = Iron.controller().state.get("inviteMessage");
      return res && res.url;
    },

    sent: function () {
      const res = Iron.controller().state.get("inviteMessage");
      return res && res.sent;
    },
  });
  const maybeScrollLog = function () {
    const elem = document.getElementById("adminLog");
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
        const elem2 = document.getElementById("adminLog");
        if (elem2) scrollLogToBottom(elem2);
      });
    }
  };

  const scrollLogToBottom = function (elem) {
    elem.scrollTop = elem.scrollHeight;
  };

  Template.adminLog.onCreated(function () {
    const state = Iron.controller().state;
    const token = state.get("token");
    this.subscribe("adminLog", token);
  });

  Template.adminLog.helpers({
    setDocumentTitle: function () {
      document.title = "Log · Admin · " + globalDb.getServerTitle();
    },

    html: function () {
      // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
      return AnsiUp.ansi_to_html(AdminLog.find({}, { $sort: { _id: 1 } })
              .map(function (entry) { return entry.text; })
              .join(""), { use_classes:true });
      // jscs:enable requireCamelCaseOrUpperCaseIdentifiers
    },
  });

  Template.adminCaps.onCreated(function () {
    const state = Iron.controller().state;
    const token = state.get("token");
    this.subscribe("adminApiTokens", token);

    // TODO(perf): Don't subscribe to all users, just to the ones that are referenced from
    //   the relevant ApiTokens.
    this.subscribe("allUsers", token);
  });

  Template.adminCaps.helpers({
    setDocumentTitle: function () {
      document.title = "Capabilities · Admin · " + globalDb.getServerTitle();
    },

    showPowerboxOffer: function () {
      const state = Iron.controller().state;
      return !!state.get("powerboxOfferUrl");
    },

    powerboxOfferData: function () {
      const state = Iron.controller().state;
      return {
        get: function () {
          return {
            offer: {
              url: state.get("powerboxOfferUrl"),
            },
            onDismiss: () => {
              state.set("powerboxOfferUrl", null);
            },
          };
        },
      };
    },

    caps: function () {
      return ApiTokens.find({
        $or: [
          { "frontendRef.ipNetwork": { $exists: true } },
          { "frontendRef.ipInterface": { $exists: true } },
        ],
      });
    },

    userName: function () {
      const userId = findAdminUserForToken(this);
      const user = Meteor.users.findOne({ _id: userId });
      if (!user) {
        return "no user";
      }

      const identityId = SandstormDb.getUserIdentityIds(user)[0];
      const identity = Meteor.users.findOne({ _id: identityId });
      if (identity) {
        SandstormDb.fillInProfileDefaults(identity);
        return identity.profile.name;
      }
    },

    isDisabled: function () {
      return !this.userId;
    },

    disabled: function () {
      return this.revoked;
    },
  });

  const updateCap = function (capId, value) {
    const state = Iron.controller().state;
    resetResult(state);
    if (!value) {
      state.set("successMessage", "Capability has been re-enabled.");
    } else {
      state.set("successMessage", "Capability has been disabled.");
    }

    const handleErrorBound = handleError.bind(state);
    Meteor.call("adminToggleDisableCap", state.get("token"), capId, value, handleErrorBound);
  };

  Template.adminCaps.events({
    "click #offer-ipnetwork": function (event) {
      const state = Iron.controller().state;
      resetResult(state);
      state.set("successMessage", "IpNetwork webkey created. Look for it in the top bar.");
      Meteor.call("offerIpNetwork", this.token, function (err, webkey) {
        state.set("powerboxOfferUrl", webkey);
        handleError.call(state, err);
      });

      return false; // prevent form from submitting
    },

    "click #offer-ipinterface": function (event) {
      const state = Iron.controller().state;
      resetResult(state);
      state.set("successMessage", "IpInterface webkey created. Look for it in the top bar.");
      Meteor.call("offerIpInterface", this.token, function (err, webkey) {
        state.set("powerboxOfferUrl", webkey);
        handleError.call(state, err);
      });

      return false; // prevent form from submitting
    },

    "click #powerbox-offer-popup-closer": function (event) {
      const state = Iron.controller().state;
      return state.set("powerboxOfferUrl", null);
    },

    "click .disable-cap": function (event) {
      const capId = event.target.getAttribute("data-id");
      const token = ApiTokens.findOne({ _id: capId });

      updateCap(capId, !token.revoked);
    },
  });

  Template.adminAdvanced.events({
    "submit #admin-settings-form": function (event) {
      const state = Iron.controller().state;
      const token = this.token;
      resetResult(state);
      state.set("numSettings", 12);

      const handleErrorBound = handleError.bind(state);
      Meteor.call("setSetting", token, "serverTitle",
                  event.target.serverTitle.value, handleErrorBound);
      Meteor.call("setSetting", token, "returnAddress",
                  event.target.returnAddress.value, handleErrorBound);
      Meteor.call("setSetting", token, "splashUrl", event.target.splashUrl.value, handleErrorBound);
      Meteor.call("setSetting", token, "signupDialog", event.target.signupDialog.value, handleErrorBound);
      Meteor.call("setSetting", token, "termsUrl", event.target.termsUrl.value, handleErrorBound);
      Meteor.call("setSetting", token, "privacyUrl", event.target.privacyUrl.value, handleErrorBound);
      Meteor.call("setSetting", token, "adminAlert", event.target.adminAlert.value, handleErrorBound);
      Meteor.call("setSetting", token, "appMarketUrl", event.target.appMarketUrl.value, handleErrorBound);
      Meteor.call("setSetting", token, "appIndexUrl", event.target.appIndexUrl.value, handleErrorBound);
      Meteor.call("setSetting", token, "appUpdatesEnabled", event.target.appUpdatesEnabled.checked, handleErrorBound);
      const alertTimeString = event.target.alertTime.value.trim();
      if (alertTimeString) {
        let alertTime = new Date(alertTimeString);
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
    },
  });

  Template.adminAdvanced.helpers({
    setDocumentTitle: function () {
      document.title = "Advanced · Admin · " + globalDb.getServerTitle();
    },

    serverTitle: function () {
      const setting = Settings.findOne({ _id: "serverTitle" });
      return (setting && setting.value) || "";
    },

    returnAddress: function () {
      const setting = Settings.findOne({ _id: "returnAddress" });
      return (setting && setting.value) || "";
    },

    splashUrl: function () {
      const setting = Settings.findOne({ _id: "splashUrl" });
      return (setting && setting.value) || "";
    },

    origin: function () { return getOrigin(); },

    signupDialog: function () {
      const setting = Settings.findOne({ _id: "signupDialog" });
      return (setting && setting.value) || DEFAULT_SIGNUP_DIALOG;
    },

    termsUrl: function () {
      const setting = Settings.findOne({ _id: "termsUrl" });
      return setting && setting.value;
    },

    privacyUrl: function () {
      const setting = Settings.findOne({ _id: "privacyUrl" });
      return setting && setting.value;
    },

    adminAlert: function () {
      const setting = Settings.findOne({ _id: "adminAlert" });
      return (setting && setting.value);
    },

    alertTime: function () {
      const setting = Settings.findOne({ _id: "adminAlertTime" });
      if (setting && setting.value) {
        return setting.value.toLocaleDateString() + " " + setting.value.toLocaleTimeString();
      } else {
        return "";
      }
    },

    alertUrl: function () {
      const setting = Settings.findOne({ _id: "adminAlertUrl" });
      return (setting && setting.value);
    },

    appMarketUrl: function () {
      const setting = Settings.findOne({ _id: "appMarketUrl" });
      return (setting && setting.value);
    },

    appIndexUrl: function () {
      const setting = Settings.findOne({ _id: "appIndexUrl" });
      return (setting && setting.value);
    },

    appUpdatesEnabled: function () {
      const setting = Settings.findOne({ _id: "appUpdatesEnabled" });
      return (setting && setting.value);
    },
  });
}

if (Meteor.isServer) {
  const Fs = Npm.require("fs");
  const SANDSTORM_ADMIN_TOKEN = SANDSTORM_VARDIR + "/adminToken";

  const getSmtpUrl = function () {
    const setting = Settings.findOne({ _id: "smtpUrl" });
    if (setting) {
      return setting.value;
    } else {
      return process.env.MAIL_URL;
    }
  };

  const tokenIsValid = function (token) {
    if (token && Fs.existsSync(SANDSTORM_ADMIN_TOKEN)) {
      const stats = Fs.statSync(SANDSTORM_ADMIN_TOKEN);
      const expireTime = new Date(Date.now() - ADMIN_TOKEN_EXPIRATION_TIME);
      if (stats.mtime < expireTime) {
        return false;
      } else {
        return Fs.readFileSync(SANDSTORM_ADMIN_TOKEN, { encoding: "utf8" }) === token;
      }
    } else {
      return false;
    }
  };

  const checkAuth = function (token) {
    check(token, Match.OneOf(undefined, null, String));
    if (!isAdmin() && !tokenIsValid(token)) {
      throw new Meteor.Error(403, "User must be admin or provide a valid token");
    }
  };

  function clearAdminToken(token) {
    if (tokenIsValid(token)) {
      Fs.unlinkSync(SANDSTORM_ADMIN_TOKEN);
      console.log("Admin token deleted.");
    }
  }

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
      const oauthServices = ["google", "github"];
      if (value && (oauthServices.indexOf(serviceName) != -1)) {
        const ServiceConfiguration = Package["service-configuration"].ServiceConfiguration;
        const config = ServiceConfiguration.configurations.findOne({ service: serviceName });
        if (!config) {
          throw new Meteor.Error(403, "You must configure the " + serviceName +
            " service before you can enable it. Click the \"configure\" link.");
        }

        if (!config.clientId || !config.secret) {
          throw new Meteor.Error(403, "You must provide a non-empty clientId and secret for the " +
            serviceName + " service before you can enable it. Click the \"configure\" link.");
        }
      }

      Settings.upsert({ _id: serviceName }, { $set: { value: value } });
      if (value) {
        Settings.update({ _id: serviceName }, { $unset: { automaticallyReset: 1 } });
      }
    },

    setSetting: function (token, name, value) {
      checkAuth(token);
      check(name, String);
      check(value, Match.OneOf(null, String, Date, Boolean));

      Settings.upsert({ _id: name }, { $set: { value: value } });
    },

    getSmtpUrl: function (token) {
      checkAuth(token);

      return getSmtpUrl();
    },

    adminConfigureLoginService: function (token, options) {
      checkAuth(token);
      check(options, Match.ObjectIncluding({ service: String }));

      const ServiceConfiguration = Package["service-configuration"].ServiceConfiguration;

      ServiceConfiguration.configurations.upsert({ service: options.service }, options);
    },

    clearResumeTokensForService: function (token, serviceName) {
      checkAuth(token);
      check(serviceName, String);

      const query = {};
      query["services." + serviceName] = { $exists: true };
      Meteor.users.find(query).forEach(function (identity) {
        if (identity.services.resume && identity.services.resume.loginTokens &&
            identity.services.resume.loginTokens.length > 0) {
          Meteor.users.update({ _id: identity._id }, { $set: { "services.resume.loginTokens": [] } });
        }

        Meteor.users.update({ "loginIdentities.id": identity._id },
                            { $set: { "services.resume.loginTokens": [] } });
      });
    },

    adminUpdateUser: function (token, userInfo) {
      checkAuth(token);
      check(userInfo, {
        userId: String,
        signupKey: Boolean,
        isAdmin: Boolean,
      });

      const userId = userInfo.userId;
      if (userId === Meteor.userId() && !userInfo.isAdmin) {
        throw new Meteor.Error(403, "User cannot remove admin permissions from itself.");
      }

      Meteor.users.update({ _id: userId }, { $set: _.omit(userInfo, ["_id", "userId"]) });
    },

    testSend: function (token, smtpUrl, to) {
      checkAuth(token);
      check(smtpUrl, String);
      check(to, String);

      SandstormEmail.send({
        to: to,
        from: globalDb.getServerTitle() + " <" + globalDb.getReturnAddress() + ">",
        subject: "Testing your Sandstorm's SMTP setting",
        text: "Success! Your outgoing SMTP is working.",
        smtpUrl: smtpUrl,
      });
    },

    createSignupKey: function (token, note, quota) {
      checkAuth(token);
      check(note, String);
      check(quota, Match.OneOf(undefined, null, Number));

      const key = Random.id();
      const content = { _id: key, used: false, note: note };
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
      for (const i in list) {
        const email = list[i].trim();

        if (email) {
          const key = Random.id();

          const content = {
            _id: key,
            used: false,
            note: "E-mail invite to " + email,
            email: email,
            definitelySent: false,
          };
          if (typeof quota === "number") content.quota = quota;
          SignupKeys.insert(content);
          SandstormEmail.send({
            to: email,
            from: from,
            subject: subject,
            text: message.replace(/\$KEY/g, origin + Router.routes.signup.path({ key: key })),
          });
          SignupKeys.update(key, { $set: { definitelySent: true } });
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

      const requirements = [
        { userIsAdmin: Meteor.userId() },
      ];
      const sturdyRef = waitPromise(
        saveFrontendRef({ ipNetwork: true }, { webkey: null }, requirements)
      ).sturdyRef;
      return ROOT_URL.protocol + "//" + makeWildcardHost("api") + "#" + sturdyRef;
    },

    offerIpInterface: function (token) {
      checkAuth(token);
      if (!isAdmin()) {
        throw new Meteor.Error(403, "Offering IpInterface is only allowed for logged in users " +
          "(a token is not sufficient). Please sign in with an admin account");
      }

      const requirements = [
        { userIsAdmin: Meteor.userId() },
      ];
      const sturdyRef = waitPromise(
        saveFrontendRef({ ipInterface: true }, { webkey: null }, requirements)
      ).sturdyRef;
      return ROOT_URL.protocol + "//" + makeWildcardHost("api") + "#" + sturdyRef;
    },

    adminToggleDisableCap: function (token, capId, value) {
      checkAuth(token);
      check(capId, String);
      check(value, Boolean);

      if (value) {
        ApiTokens.update({ _id: capId }, { $set: { revoked: true } });
      } else {
        ApiTokens.update({ _id: capId }, { $set: { revoked: false } });
      }
    },

    updateQuotas: function (token, list, quota) {
      checkAuth(token);
      check(list, String);
      check(quota, Match.OneOf(undefined, null, Number));

      if (!list.trim()) {
        throw new Meteor.Error(400, "Must enter addresses.");
      }

      const items = list.split("\n");
      const invalid = [];
      for (const i in items) {
        const modifier = (typeof quota === "number") ? { $set: { quota: quota } }
                                                   : { $unset: { quota: "" } };
        let n = SignupKeys.update({ email: items[i] }, modifier, { multi: true });
        n += Meteor.users.update({ signupEmail: items[i] }, modifier, { multi: true });

        if (n < 1) invalid.push(items[i]);
      }

      if (invalid.length > 0) {
        throw new Meteor.Error(404, "These addresses did not map to any user nor invite: " +
            invalid.join(", "));
      }
    },

    dismissAdminStatsNotifications: function (token) {
      checkAuth(token);
      globalDb.collections.notifications.remove({ "admin.type": "reportStats" });
    },

    signUpAsAdmin: function (token) {
      check(token, String);
      checkAuth(token);
      if (!this.userId) {
        throw new Meteor.Error(403, "Must be logged in to sign up as admin.");
      }

      if (!Meteor.user().loginIdentities) {
        throw new Meteor.Error(403, "Must be logged into an account to sign up as admin.");
      }

      Meteor.users.update({ _id: this.userId }, { $set: { isAdmin: true, signupKey: "admin" } });
      clearAdminToken(token);
    },
  });

  const authorizedAsAdmin = function (token, userId) {
    return Match.test(token, Match.OneOf(undefined, null, String)) &&
           ((userId && isAdminById(userId)) || tokenIsValid(token));
  };

  Meteor.publish("admin", function (token) {
    if (!authorizedAsAdmin(token, this.userId)) return [];
    return Settings.find();
  });

  Meteor.publish("adminServiceConfiguration", function (token) {
    if (!authorizedAsAdmin(token, this.userId)) return [];
    return Package["service-configuration"].ServiceConfiguration.configurations.find();
  });

  Meteor.publish("publicAdminSettings", function () {
    return Settings.find({ _id: { $in: publicAdminSettings } });
  });

  Meteor.publish("adminToken", function (token) {
    check(token, String);
    this.added("adminToken", "adminToken", { tokenIsValid: tokenIsValid(token) });
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

  Meteor.publish("allPackages", function (token) {
    if (!authorizedAsAdmin(token, this.userId)) return [];
    return Packages.find({ manifest: { $exists: true } },
        { fields: { appId: 1, "manifest.appVersion": 1,
        "manifest.actions": 1, "manifest.appTitle": 1, }, });
  });

  Meteor.publish("realTimeStats", function (token) {
    if (!authorizedAsAdmin(token, this.userId)) return [];

    // Last five minutes.
    this.added("realTimeStats", "now", computeStats(new Date(Date.now() - 5 * 60 * 1000)));

    // Since last sample.
    const lastSample = ActivityStats.findOne({}, { sort: { timestamp: -1 } });
    const lastSampleTime = lastSample ? lastSample.timestamp : new Date(0);
    this.added("realTimeStats", "today", computeStats(lastSampleTime));

    // TODO(someday): Update every few minutes?

    this.ready();
  });

  Meteor.publish("adminLog", function (token) {
    if (!authorizedAsAdmin(token, this.userId)) return [];

    const logfile = SANDSTORM_LOGDIR + "/sandstorm.log";

    const fd = Fs.openSync(logfile, "r");
    const startSize = Fs.fstatSync(fd).size;

    // Start tailing at EOF - 8k.
    let offset = Math.max(0, startSize - 8192);

    const _this = this;
    function doTail() {
      for (;;) {
        const buf = new Buffer(Math.max(1024, startSize - offset));
        const n = Fs.readSync(fd, buf, 0, buf.length, offset);
        if (n <= 0) break;
        _this.added("adminLog", offset, { text: buf.toString("utf8", 0, n) });
        offset += n;
      }
    }

    // Watch the file for changes.
    const watcher = Fs.watch(logfile, { persistent: false }, Meteor.bindEnvironment(doTail));

    // When the subscription stops, stop watching the file.
    this.onStop(function () {
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
    return ApiTokens.find({
      $or: [
        { "frontendRef.ipNetwork": { $exists: true } },
        { "frontendRef.ipInterface": { $exists: true } },
      ],
    }, {
      fields: {
        frontendRef: 1,
        created: 1,
        requirements: 1,
        revoked: 1,
      },
    });
  });
}

function serviceEnabled(name) {
  const setting = Settings.findOne({ _id: name });
  return setting && !!setting.value;
}

if (Meteor.server) {
  function observeOauthService(name) {
    Settings.find({ _id: name, value: true }).observe({
      added: function () {
        // Tell the oauth library it should accept login attempts from this service.
        Accounts.oauth.registerService(name);
      },

      removed: function () {
        // Tell the oauth library it should deny login attempts from this service.
        Accounts.oauth.unregisterService(name);
      },
    });
  }

  observeOauthService("github");
  observeOauthService("google");
}

Accounts.identityServices.github = {
  isEnabled: function () {
    return serviceEnabled("github");
  },

  loginTemplate: {
    name: "oauthLoginButton",
    priority: 1,
    data: {
      method: "loginWithGithub",
      name: "github",
      displayName: "GitHub",
    },
  },
};

Accounts.identityServices.google = {
  isEnabled: function () {
    return serviceEnabled("google");
  },

  loginTemplate: {
    name: "oauthLoginButton",
    priority: 2,
    data: {
      method: "loginWithGoogle",
      name: "google",
      displayName: "Google",
    },
  },
};

Accounts.identityServices.email = {
  isEnabled: function () {
    return serviceEnabled("emailToken");
  },

  loginTemplate: {
    name: "emailLoginForm",
    priority: 10, // Put it at the bottom of the list.
  },
};
