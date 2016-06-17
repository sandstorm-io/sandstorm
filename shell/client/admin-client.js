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

DEFAULT_SIGNUP_DIALOG = "You've been invited to join this Sandstorm server!";

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

// Export for use in other admin/ routes
getToken = function () {
  const state = Iron.controller().state;
  const token = state.get("token");
  if (!token) {
    return;
  } else {
    return { _token: token };
  }
};

const handleError = function (err) {
  Meteor.setTimeout(() => {
    this.set("fadeAlert", true);
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

const updateUser = function (options) {
  const state = Iron.controller().state;
  const token = state.get("token");
  resetResult(state);
  state.set("successMessage", "User has been updated.");
  const handleErrorBound = handleError.bind(state);
  Meteor.call("adminUpdateUser", token, options, handleErrorBound);
};

const capitalize = function (str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
};

AdminToken = new Mongo.Collection("adminToken");  // see Meteor.publish("adminToken")
AdminLog = new Meteor.Collection("adminLog");
Meteor.subscribe("publicAdminSettings");

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

  featureKeyActive: function () {
    return Router.current().route.getName() == "adminFeatureKeyPage";
  },

  wildcardHostSeemsBroken: function () {
    if (Session.get("alreadyTestedWildcardHost") &&
        !Session.get("wildcardHostWorks")) {
      return true;
    }

    return false;
  },

  websocketSeemsBroken: function () {
    // This returns true if Meteor is using a connection that is *not* a websocket,
    // so long as we have verified that the attributes we expect are in place.
    if (Meteor &&
        Meteor.connection &&
        Meteor.connection._stream &&
        Meteor.connection._stream.socket &&
        Meteor.connection._stream.socket.protocol &&
        Meteor.connection._stream.socket.protocol !== "websocket") {
      return true;
    } else {
      return false;
    }
  },

  getToken: getToken,
});

const emailConfigFromForm = function (form) {
  const portValue = parseInt(form.smtpPort.value);
  const mailConfig = {
    hostname: form.smtpHostname.value,
    port: _.isNaN(portValue) ? 25 : portValue,
    auth: {
      user: form.smtpUsername.value,
      pass: form.smtpPassword.value,
    },
    returnAddress: form.smtpReturnAddress.value,
  };
  return mailConfig;
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
    // prevent form from submitting
    event.preventDefault();
    event.stopImmediatePropagation();
    const state = Iron.controller().state;
    state.set("isEmailTestActive", !state.get("isEmailTestActive"));
  },

  "click #admin-settings-send-test": function (event) {
    // prevent form from submitting
    event.preventDefault();
    event.stopImmediatePropagation();
    const state = Iron.controller().state;
    resetResult(state);
    const handleErrorBound = handleError.bind(state);
    state.set("successMessage", "Email has been sent.");
    const form = document.getElementById("admin-settings-form");
    const mailConfig = emailConfigFromForm(form);
    Meteor.call("testSend", this.token, mailConfig,
                document.getElementById("email-test-to").value, handleErrorBound);
  },

  "submit #admin-settings-form": function (event, template) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const state = Iron.controller().state;
    const token = this.token;
    resetResult(state);
    if (globalDb.isFeatureKeyValid()) {
      state.set("numSettings", 17);
    } else {
      state.set("numSettings", 4);
    }

    const handleErrorBound = handleError.bind(state);
    if (event.target.emailTokenLogin.checked &&
            (!event.target.smtpHostname.value || !event.target.smtpPort.value)) {
      handleErrorBound(new Meteor.Error(400,
        "You must configure an SMTP server to use email login."));
      return false;
    }

    // Construct state from email form.
    const mailConfig = emailConfigFromForm(event.target);

    Meteor.call("setAccountSetting", token, "google", event.target.googleLogin.checked, handleErrorBound);
    Meteor.call("setAccountSetting", token, "github", event.target.githubLogin.checked, handleErrorBound);
    Meteor.call("setAccountSetting", token, "emailToken", event.target.emailTokenLogin.checked, handleErrorBound);
    Meteor.call("setSmtpConfig", token, mailConfig, handleErrorBound);
    if (globalDb.isFeatureKeyValid()) {
      Meteor.call("setAccountSetting", token, "ldap", event.target.ldapLogin.checked, handleErrorBound);
      Meteor.call("setSetting", token, "ldapUrl", event.target.ldapUrl.value, handleErrorBound);
      Meteor.call("setSetting", token, "ldapBase", event.target.ldapBase.value, handleErrorBound);
      Meteor.call("setSetting", token, "ldapSearchUsername", event.target.ldapSearchUsername.value, handleErrorBound);
      Meteor.call("setSetting", token, "ldapFilter", event.target.ldapFilter.value, handleErrorBound);
      Meteor.call("setSetting", token, "ldapSearchBindDn", event.target.ldapSearchBindDn.value, handleErrorBound);
      Meteor.call("setSetting", token, "ldapSearchBindPassword", event.target.ldapSearchBindPassword.value, handleErrorBound);

      Meteor.call("setSetting", token, "ldapNameField", event.target.ldapNameField.value, handleErrorBound);
      Meteor.call("setSetting", token, "ldapEmailField", event.target.ldapEmailField.value, handleErrorBound);

      Meteor.call("setAccountSetting", token, "saml", event.target.samlLogin.checked, handleErrorBound);
      Meteor.call("setSetting", token, "samlEntryPoint", event.target.samlEntryPoint.value, handleErrorBound);
      Meteor.call("setSetting", token, "samlPublicCert", event.target.samlPublicCert.value, handleErrorBound);

      const orgSettings = {
        membership: {
          emailToken: {
            enabled: event.currentTarget.isOrganizationEmail.checked,
            domain: event.currentTarget.organizationEmail.value.toLowerCase(),
          },
          google: {
            enabled: event.currentTarget.isOrganizationGoogle.checked,
            domain: event.currentTarget.organizationGoogle.value.toLowerCase(),
          },
          ldap: {
            enabled: event.currentTarget.isOrganizationLdap.checked,
          },
          saml: {
            enabled: event.currentTarget.isOrganizationSaml.checked,
          },
        },
        settings: {
          disallowGuests: event.currentTarget.disallowGuests.checked,
          shareContacts: event.currentTarget.autoShareContacts.checked,
        },
      };
      Meteor.call("saveOrganizationSettings", token, orgSettings, handleErrorBound);
    }

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

  isOrganizationGoogle: function () {
    return globalDb.getOrganizationGoogleEnabled();
  },

  organizationGoogle: function () {
    const val = globalDb.getOrganizationGoogleDomain();
    if (!val) {
      // Setting has never been set before. Show a reasonable default
      const user = Meteor.user();
      const identityIds = SandstormDb.getUserIdentityIds(user);

      for (let i = 0; i < identityIds.length; i++) {
        const identity = Meteor.users.findOne({ _id: identityIds[i] });
        if (identity && identity.services.google && identity.services.google.hd) {
          return identity.services.google.hd;
        }
      }

      return "";
    }

    return val;
  },

  isOrganizationEmail: function () {
    return globalDb.getOrganizationEmailEnabled();
  },

  organizationEmail: function () {
    const val = globalDb.getOrganizationEmailDomain();
    if (!val) {
      // Setting has never been set before. Show a reasonable default
      const user = Meteor.user();
      const identityIds = SandstormDb.getUserIdentityIds(user);

      for (let i = 0; i < identityIds.length; i++) {
        const identity = Meteor.users.findOne({ _id: identityIds[i] });
        if (identity && identity.services.email) {
          return identity.services.email.email.split("@")[1];
        }
      }

      return "";
    }

    return val;
  },

  isOrganizationLdap: function () {
    return globalDb.getOrganizationLdapEnabled();
  },

  isOrganizationSaml: function () {
    return globalDb.getOrganizationSamlEnabled();
  },

  disallowGuests: function () {
    return globalDb.getOrganizationDisallowGuestsRaw();
  },

  autoShareContacts: function () {
    return globalDb.getOrganizationShareContactsRaw();
  },

  ldapEnabled: function () {
    const setting = Settings.findOne({ _id: "ldap" });
    if (setting) {
      return setting.value;
    } else {
      return false;
    }
  },

  ldapUrl: function () {
    return globalDb.getLdapUrl() || "ldap://localhost:389";
  },

  ldapBase: function () {
    return globalDb.getLdapBase() || "OU=People,DC=example,DC=com";
  },

  ldapDnPattern: function () {
    return globalDb.getLdapDnPattern() || "uid=$USERNAME,OU=People,DC=example,DC=com";
  },

  ldapNameField: function () {
    return globalDb.getLdapNameField() || "cn";
  },

  ldapEmailField: function () {
    return globalDb.getLdapEmailField();
  },

  ldapFilter: function () {
    return globalDb.getLdapFilter();
  },

  ldapSearchBindDn: function () {
    return globalDb.getLdapSearchBindDn();
  },

  ldapSearchBindPassword: function () {
    return globalDb.getLdapSearchBindPassword();
  },

  ldapSearchUsername: function () {
    return globalDb.getLdapSearchUsername() || "uid";
  },

  samlEnabled: function () {
    const setting = Settings.findOne({ _id: "saml" });
    if (setting) {
      return setting.value;
    } else {
      return false;
    }
  },

  samlEntryPoint: function () {
    return globalDb.getSamlEntryPoint();
  },

  samlPublicCert: function () {
    return globalDb.getSamlPublicCert();
  },

  smtpConfig() {
    const config = Settings.findOne({ _id: "smtpConfig" });
    return config && config.value;
  },

  isEmailTestActive: function () {
    return Iron.controller().state.get("isEmailTestActive");
  },

  getToken: getToken,
  isFeatureKeyValid: function () {
    return globalDb.isFeatureKeyValid();
  },

  featuresPath: function () {
    const state = Iron.controller().state;
    const token = state.get("token");
    return "/admin/features" + (token ? "/" + token : "");
  },

  rootUrl: function () {
    return window.location.protocol + "//" + window.location.host;
  },

  entityId: function () {
    return window.location.hostname;
  },
});

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
            .join(""), { use_classes: true });
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
    state.set("numSettings", 11);

    const handleErrorBound = handleError.bind(state);
    Meteor.call("setSetting", token, "serverTitle",
                event.target.serverTitle.value, handleErrorBound);
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

Template.featureKeyUploadForm.onCreated(function () {
  this.error = new ReactiveVar(undefined);
  this.text = new ReactiveVar("");
});

Template.featureKeyUploadForm.events({
  "submit form": function (evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const state = Iron.controller().state;
    const token = state.get("token");

    const instance = Template.instance();
    const text = instance.text.get();
    Meteor.call("submitFeatureKey", token, text, (err) => {
      if (err) {
        instance.error.set(err.message);
      } else {
        instance.error.set(undefined);
        instance.data && instance.data.successCb && instance.data.successCb();
      }
    });
  },

  "change input[type='file']": function (evt) {
    const file = evt.currentTarget.files[0];
    const instance = Template.instance();
    const state = Iron.controller().state;
    const token = state.get("token");
    if (file) {
      // Read the file into memory, then call submitFeatureKey with the file's contents.
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        Meteor.call("submitFeatureKey", token, reader.result, (err) => {
          if (err) {
            instance.error.set(err.message);
          } else {
            instance.data && instance.data.successCb && instance.data.successCb();
          }
        });
      });
      reader.readAsText(file);
    }
  },

  "input textarea"(evt) {
    const instance = Template.instance();
    instance.text.set(evt.currentTarget.value);
  },
});

Template.featureKeyUploadForm.helpers({
  currentError: function () {
    return Template.instance().error.get();
  },

  text() {
    return Template.instance().text.get();
  },

  disabled() {
    return !Template.instance().text.get();
  },
});

Template.adminFeatureKey.helpers({
  currentFeatureKey: function () {
    return globalDb.currentFeatureKey();
  },
});

Template.adminFeatureKeyPage.helpers({
  setDocumentTitle: function () {
    document.title = "Feature Key · Admin · " + globalDb.getServerTitle();
  },

  settingsPath: function () {
    const state = Iron.controller().state;
    const token = state.get("token");
    return "/admin/settings" + (token ? "/" + token : "");
  },

  hasFeatureKey: function () {
    return !!globalDb.currentFeatureKey();
  },
});

Template.adminFeatureKeyDetails.helpers({
  computeValidity: function (featureKey) {
    const nowSec = Date.now() / 1000;
    const expires = parseInt(featureKey.expires);
    if (expires >= nowSec) {
      const soonWindowLengthSec = 60 * 60 * 24 * 7; // one week
      if (expires < (nowSec + soonWindowLengthSec)) {
        return {
          className: "expires-soon",
          labelText: "Expires soon",
        };
      } else {
        return {
          className: "valid",
          labelText: "Valid",
        };
      }
    } else {
      return {
        className: "expired",
        labelText: "Expired",
      };
    }
  },

  renderDateString: function (stringSecondsSinceEpoch) {
    if (stringSecondsSinceEpoch === "18446744073709551615") { // UINT64_MAX means "never expires"
      return "Never";
    }

    // TODO: deduplicate this with the one in shared/shell.js or just import moment.js
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    const d = new Date();
    d.setTime(parseInt(stringSecondsSinceEpoch) * 1000);

    return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  },
});

Template.adminFeatureKeyModifyForm.onCreated(function () {
  this.showForm = new ReactiveVar(undefined);
});

Template.adminFeatureKeyModifyForm.helpers({
  showUpdateForm() {
    return Template.instance().showForm.get() === "update";
  },

  showDeleteForm() {
    return Template.instance().showForm.get() === "delete";
  },

  token() {
    const state = Iron.controller().state;
    return state.get("token");
  },

  hideFormCb: function () {
    const instance = Template.instance();
    return () => {
      instance.showForm.set(undefined);
    };
  },
});

Template.adminFeatureKeyModifyForm.events({
  "submit .feature-key-modify-form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    Template.instance().showForm.set("update");
  },

  "click button.feature-key-delete-button"(evt) {
    Template.instance().showForm.set("delete");
  },
});

Template.featureKeyDeleteForm.events({
  "submit .feature-key-delete-form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    Meteor.call("submitFeatureKey", instance.data.token, null, (err) => {
      if (err) {
        console.error("Couldn't delete feature key");
      } else {
        instance.data.successCb && instance.data.successCb();
      }
    });
  },

  "click button.cancel"(evt) {
    const instance = Template.instance();
    instance.data.cancelCb && instance.data.cancelCb();
  },
});

const adminRoute = RouteController.extend({
  template: "admin",
  waitOn: function () {
    const subs = [
      Meteor.subscribe("admin", this.params._token),
      Meteor.subscribe("adminServiceConfiguration", this.params._token),
      Meteor.subscribe("featureKey", true, this.params._token),
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
                { timeout: 4000 }, (error, response) => {
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

    const state = this.state;
    resetResult(state);
    state.set("configurationServiceName", null);
    state.set("token", this.params._token);
    this.render();
  },
});

Router.map(function () {
  this.route("adminSettings", {
    path: "/admin-old/settings/:_token?",
    controller: adminRoute,
  });
  this.route("adminUsers", {
    path: "/admin-old/users/:_token?",
    controller: adminRoute,
  });
  this.route("adminStats", {
    path: "/admin-old/stats/:_token?",
    controller: adminRoute,
  });
  this.route("adminLog", {
    path: "/admin-old/log/:_token?",
    controller: adminRoute,
  });
  this.route("adminInvites", {
    path: "/admin-old/invites/:_token?",
    controller: adminRoute,
  });
  this.route("adminCaps", {
    path: "/admin-old/capabilities/:_token?",
    controller: adminRoute,
  });
  this.route("adminAdvanced", {
    path: "/admin-old/advanced/:_token?",
    controller: adminRoute,
  });
  this.route("adminFeatureKeyPage", {
    path: "/admin-old/features/:_token?",
    controller: adminRoute,
  });
  this.route("adminOld", {
    path: "/admin-old/:_token?",
    action: function () {
      this.redirect("adminSettings", this.params);
    },
  });
});

const newAdminRoute = RouteController.extend({
  template: "newAdmin",
  waitOn: function () {
    const subs = [
      Meteor.subscribe("admin", this.params._token),
      Meteor.subscribe("adminServiceConfiguration", this.params._token),
      Meteor.subscribe("featureKey", true, this.params._token),
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
    return {
      isUserPermitted: isAdmin(),
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
});
