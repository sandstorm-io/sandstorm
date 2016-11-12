/* global Settings */

Template.newAdminIdentity.helpers({
  hasFeatureKey() {
    return globalDb.isFeatureKeyValid();
  },
});

const idpData = function (configureCallback) {
  const emailTokenEnabled = globalDb.getSettingWithFallback("emailToken", false);
  const googleSetting = globalDb.collections.settings.findOne("google");
  const googleEnabled = (googleSetting && googleSetting.value) || false;
  const githubSetting = globalDb.collections.settings.findOne("github");
  const githubEnabled = (githubSetting && githubSetting.value) || false;
  const ldapEnabled = globalDb.getSettingWithFallback("ldap", false);
  const samlEnabled = globalDb.getSettingWithFallback("saml", false);
  return [
    {
      id: "email-token",
      label: "E-mail (passwordless)",
      icon: "/email.svg", // Or use identicons
      enabled: emailTokenEnabled,
      popupTemplate: "adminIdentityProviderConfigureEmail",
      onConfigure() {
        configureCallback("email-token");
      },
    },
    {
      id: "google",
      label: "Google",
      icon: "/google.svg", // Or use identicons
      enabled: googleEnabled,
      resetNote: !googleEnabled && googleSetting && googleSetting.automaticallyReset,
      popupTemplate: "adminIdentityProviderConfigureGoogle",
      onConfigure() {
        configureCallback("google");
      },
    },
    {
      id: "github",
      label: "GitHub",
      icon: "/github.svg", // Or use identicons
      enabled: githubEnabled,
      resetNote: !githubEnabled && githubSetting && githubSetting.automaticallyReset,
      popupTemplate: "adminIdentityProviderConfigureGitHub",
      onConfigure() {
        configureCallback("github");
      },
    },
    {
      id: "ldap",
      label: "LDAP",
      icon: "/ldap.svg", // Or use identicons
      enabled: ldapEnabled,
      restricted: true,
      popupTemplate: "adminIdentityProviderConfigureLdap",
      onConfigure() {
        configureCallback("ldap");
      },
    },
    {
      id: "saml",
      label: "SAML",
      icon: "/ldap.svg", // Or use identicons
      enabled: samlEnabled,
      restricted: true,
      popupTemplate: "adminIdentityProviderConfigureSaml",
      onConfigure() {
        configureCallback("saml");
      },
    },
  ];
};

Template.adminIdentityProviderTable.onCreated(function () {
  this.currentPopup = new ReactiveVar(undefined);
});

Template.adminIdentityProviderTable.helpers({
  idpData() {
    const instance = Template.instance();
    return idpData((idp) => {
      instance.currentPopup.set(idp);
    });
  },

  currentPopupIs(arg) {
    const instance = Template.instance();
    return instance.currentPopup.get() === arg;
  },

  popupData() {
    const instance = Template.instance();
    // The data context passed in to the popupTemplate instance, as specified in the idpData above.
    return {
      onDismiss() {
        return () => {
          instance.currentPopup.set(undefined);
        };
      },
    };
  },
});

Template.adminIdentityRow.events({
  "click button.base-url-change-button"() {
    const instance = Template.instance();
    instance.data.idp.onConfigure();
  },

  "click button.configure-idp"() {
    const instance = Template.instance();
    instance.data.idp.onConfigure();
  },

  "click button.get-feature-key"() {
    const instance = Template.instance();
    const route = instance.data.featureKeyRoute;
    if (route) {
      Router.go(instance.data.featureKeyRoute);
    }
  },
});

Template.adminIdentityRow.helpers({
  needsFeatureKey() {
    const instance = Template.instance();
    const featureKeyValid = globalDb.isFeatureKeyValid();
    return instance.data.idp.restricted && !featureKeyValid;
  },
});

const setAccountSettingCallback = function (err) {
  if (err) {
    this.errorMessage.set(err.message);
  } else {
    this.data.onDismiss()();
  }
};

// Email form.
Template.adminIdentityProviderConfigureEmail.onCreated(function () {
  this.errorMessage = new ReactiveVar(undefined);
  this.setAccountSettingCallback = setAccountSettingCallback.bind(this);
});

Template.adminIdentityProviderConfigureEmail.onRendered(function () {
  // Focus the first input when the form is shown.
  this.find("button.idp-modal-save").focus();
});

Template.adminIdentityProviderConfigureEmail.events({
  "click .idp-modal-disable"(evt) {
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");
    Meteor.call("setAccountSetting", token, "emailToken", false, instance.setAccountSettingCallback);
  },

  "click .idp-modal-save"(evt) {
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");
    Meteor.call("setAccountSetting", token, "emailToken", true, instance.setAccountSettingCallback);
  },

  "click .idp-modal-cancel"(evt) {
    const instance = Template.instance();
    // double invocation because there's no way to pass a callback function around in Blaze without
    // invoking it, and we need to pass it to modalDialogWithBackdrop
    instance.data.onDismiss()();
  },
});

Template.adminIdentityProviderConfigureEmail.helpers({
  emailLoginEnabled() {
    return globalDb.getSettingWithFallback("emailToken", false);
  },

  emailUnconfigured() {
    const c = globalDb.getSmtpConfig();
    return (!c.hostname || !c.port || !c.returnAddress);
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },
});

function siteUrlNoSlash() {
  // Google complains if the Javascript origin contains a trailing slash - it wants just the
  // scheme/host/port, no path.
  const urlWithTrailingSlash = Meteor.absoluteUrl();
  return urlWithTrailingSlash[urlWithTrailingSlash.length - 1] === "/" ?
         urlWithTrailingSlash.slice(0, urlWithTrailingSlash.length - 1) :
         urlWithTrailingSlash;
}

Template.googleLoginSetupInstructions.helpers({
  siteUrlNoSlash,
});

// Google form.
Template.adminIdentityProviderConfigureGoogle.onCreated(function () {
  const configurations = Package["service-configuration"].ServiceConfiguration.configurations;
  const googleConfiguration = configurations.findOne({ service: "google" });
  const clientId = (googleConfiguration && googleConfiguration.clientId) || "";
  const clientSecret = (googleConfiguration && googleConfiguration.secret) || "";

  this.clientId = new ReactiveVar(clientId);
  this.clientSecret = new ReactiveVar(clientSecret);
  this.errorMessage = new ReactiveVar(undefined);
  this.formChanged = new ReactiveVar(false);
  this.setAccountSettingCallback = setAccountSettingCallback.bind(this);
});

Template.adminIdentityProviderConfigureGoogle.onRendered(function () {
  // Focus the first input when the form is shown.
  this.find("input").focus();
});

Template.adminIdentityProviderConfigureGoogle.helpers({
  formerBaseUrl() {
    const setting = globalDb.collections.settings.findOne("google");
    const googleEnabled = (setting && setting.value) || false;
    return !googleEnabled && setting && setting.automaticallyReset && setting.automaticallyReset.baseUrlChangedFrom;
  },

  siteUrlNoSlash,

  googleEnabled() {
    return globalDb.getSettingWithFallback("google", false);
  },

  clientId() {
    const instance = Template.instance();
    return instance.clientId.get();
  },

  clientSecret() {
    const instance = Template.instance();
    return instance.clientSecret.get();
  },

  saveDisabled() {
    const instance = Template.instance();
    const googleEnabled = globalDb.getSettingWithFallback("google", false);
    return (googleEnabled && !instance.formChanged.get()) || !instance.clientId.get() || !instance.clientSecret.get();
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },
});

Template.adminIdentityProviderConfigureGoogle.events({
  "input input[name=clientId]"(evt) {
    const instance = Template.instance();
    instance.clientId.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=clientSecret]"(evt) {
    const instance = Template.instance();
    instance.clientSecret.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "click .idp-modal-disable"(evt) {
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");
    Meteor.call("setAccountSetting", token, "google", false, instance.setAccountSettingCallback);
  },

  "click .idp-modal-save"(evt) {
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");
    const configuration = {
      service: "google",
      clientId: instance.clientId.get().trim(),
      secret: instance.clientSecret.get().trim(),
      loginStyle: "redirect",
    };
    // TODO: rework this into a single Meteor method call.
    Meteor.call("adminConfigureLoginService", token, configuration, (err) => {
      if (err) {
        instance.errorMessage.set(err.message);
      } else {
        Meteor.call("setAccountSetting", token, "google", true, instance.setAccountSettingCallback);
      }
    });
  },

  "click .idp-modal-cancel"(evt) {
    const instance = Template.instance();
    // double invocation because there's no way to pass a callback function around in Blaze without
    // invoking it, and we need to pass it to modalDialogWithBackdrop
    instance.data.onDismiss()();
  },
});

Template.githubLoginSetupInstructions.helpers({
  siteUrl() {
    return Meteor.absoluteUrl();
  },
});

// GitHub form.
Template.adminIdentityProviderConfigureGitHub.onCreated(function () {
  const configurations = Package["service-configuration"].ServiceConfiguration.configurations;
  const githubConfiguration = configurations.findOne({ service: "github" });
  const clientId = (githubConfiguration && githubConfiguration.clientId) || "";
  const clientSecret = (githubConfiguration && githubConfiguration.secret) || "";

  this.clientId = new ReactiveVar(clientId);
  this.clientSecret = new ReactiveVar(clientSecret);
  this.errorMessage = new ReactiveVar(undefined);
  this.formChanged = new ReactiveVar(false);
  this.setAccountSettingCallback = setAccountSettingCallback.bind(this);
});

Template.adminIdentityProviderConfigureGitHub.onRendered(function () {
  // Focus the first input when the form is shown.
  this.find("input").focus();
});

Template.adminIdentityProviderConfigureGitHub.helpers({
  githubEnabled() {
    return globalDb.getSettingWithFallback("github", false);
  },

  formerBaseUrl() {
    const setting = globalDb.collections.settings.findOne("github");
    const googleEnabled = (setting && setting.value) || false;
    return !googleEnabled && setting && setting.automaticallyReset && setting.automaticallyReset.baseUrlChangedFrom;
  },

  siteUrl() {
    return Meteor.absoluteUrl();
  },

  clientId() {
    const instance = Template.instance();
    return instance.clientId.get();
  },

  clientSecret() {
    const instance = Template.instance();
    return instance.clientSecret.get();
  },

  saveDisabled() {
    const instance = Template.instance();
    const githubEnabled = globalDb.getSettingWithFallback("github", false);
    return (githubEnabled && !instance.formChanged.get()) || !instance.clientId.get() || !instance.clientSecret.get();
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },
});

Template.adminIdentityProviderConfigureGitHub.events({
  "input input[name=clientId]"(evt) {
    const instance = Template.instance();
    instance.clientId.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=clientSecret]"(evt) {
    const instance = Template.instance();
    instance.clientSecret.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "click .idp-modal-save"(evt) {
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");
    const configuration = {
      service: "github",
      clientId: instance.clientId.get().trim(),
      secret: instance.clientSecret.get().trim(),
      loginStyle: "redirect",
    };
    // TODO: rework this into a single Meteor method call.
    Meteor.call("adminConfigureLoginService", token, configuration, (err) => {
      if (err) {
        instance.errorMessage.set(err.message);
      } else {
        Meteor.call("setAccountSetting", token, "github", true, instance.setAccountSettingCallback);
      }
    });
  },

  "click .idp-modal-disable"(evt) {
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");
    Meteor.call("setAccountSetting", token, "github", false, instance.setAccountSettingCallback);
  },

  "click .idp-modal-cancel"(evt) {
    const instance = Template.instance();
    // double invocation because there's no way to pass a callback function around in Blaze without
    // invoking it, and we need to pass it to modalDialogWithBackdrop
    instance.data.onDismiss()();
  },
});

// LDAP form.
Template.adminIdentityProviderConfigureLdap.onCreated(function () {
  const url = globalDb.getLdapUrl();
  const searchBindDn = globalDb.getLdapSearchBindDn();
  const searchBindPassword = globalDb.getLdapSearchBindPassword();
  const base = globalDb.getLdapBase(); //"ou=users,dc=example,dc=com"
  const searchUsername = globalDb.getLdapSearchUsername() || "uid";
  const nameField = globalDb.getLdapNameField() || "cn";
  const emailField = globalDb.getLdapEmailField() || "mail";
  const filter = globalDb.getLdapFilter();
  const ldapCaCert = globalDb.getLdapCaCert();

  this.ldapUrl = new ReactiveVar(url);
  this.ldapSearchBindDn = new ReactiveVar(searchBindDn);
  this.ldapSearchBindPassword = new ReactiveVar(searchBindPassword);
  this.ldapBase = new ReactiveVar(base);
  this.ldapSearchUsername = new ReactiveVar(searchUsername);
  this.ldapNameField = new ReactiveVar(nameField);
  this.ldapEmailField = new ReactiveVar(emailField);
  this.ldapFilter = new ReactiveVar(filter);
  this.ldapCaCert = new ReactiveVar(ldapCaCert);
  this.errorMessage = new ReactiveVar(undefined);
  this.formChanged = new ReactiveVar(false);
  this.setAccountSettingCallback = setAccountSettingCallback.bind(this);
});

Template.adminIdentityProviderConfigureLdap.onRendered(function () {
  // Focus the first input when the form is shown.
  this.find("input").focus();
});

Template.adminIdentityProviderConfigureLdap.helpers({
  ldapEnabled() {
    return globalDb.getSettingWithFallback("ldap", false);
  },

  ldapUrl() {
    const instance = Template.instance();
    return instance.ldapUrl.get();
  },

  ldapBase() {
    const instance = Template.instance();
    return instance.ldapBase.get();
  },

  ldapSearchUsername() {
    const instance = Template.instance();
    return instance.ldapSearchUsername.get();
  },

  ldapFilter() {
    const instance = Template.instance();
    return instance.ldapFilter.get();
  },

  ldapCaCert() {
    const instance = Template.instance();
    return instance.ldapCaCert.get();
  },

  ldapSearchBindDn() {
    const instance = Template.instance();
    return instance.ldapSearchBindDn.get();
  },

  ldapSearchBindPassword() {
    const instance = Template.instance();
    return instance.ldapSearchBindPassword.get();
  },

  ldapNameField() {
    const instance = Template.instance();
    return instance.ldapNameField.get();
  },

  ldapEmailField() {
    const instance = Template.instance();
    return instance.ldapEmailField.get();
  },

  saveDisabled() {
    const instance = Template.instance();
    // To enable/save LDAP settings, you must provide:
    // * a nonempty URL
    // * a nonempty username attribute
    // * a nonempty given name attribute
    // * a nonempty email attribute
    const ldapEnabled = globalDb.getSettingWithFallback("ldap", false);
    return ((ldapEnabled && !instance.formChanged.get()) ||
        !instance.ldapUrl.get() ||
        !instance.ldapSearchUsername.get() ||
        !instance.ldapNameField.get() ||
        !instance.ldapEmailField.get());
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },
});

Template.adminIdentityProviderConfigureLdap.events({
  "input input[name=ldapUrl]"(evt) {
    const instance = Template.instance();
    instance.ldapUrl.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=ldapSearchBindDn]"(evt) {
    const instance = Template.instance();
    instance.ldapSearchBindDn.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=ldapSearchBindPassword]"(evt) {
    const instance = Template.instance();
    instance.ldapSearchBindPassword.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=ldapBase]"(evt) {
    const instance = Template.instance();
    instance.ldapBase.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=ldapSearchUsername]"(evt) {
    const instance = Template.instance();
    instance.ldapSearchUsername.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=ldapNameField]"(evt) {
    const instance = Template.instance();
    instance.ldapNameField.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=ldapEmailField]"(evt) {
    const instance = Template.instance();
    instance.ldapEmailField.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=ldapFilter]"(evt) {
    const instance = Template.instance();
    instance.ldapFilter.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "change textarea[name=ldapCaCert]"(evt) {
    const instance = Template.instance();
    instance.ldapCaCert.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "paste textarea[name=ldapCaCert]"(evt) {
    const instance = Template.instance();
    instance.ldapCaCert.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "click .idp-modal-disable"(evt) {
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");
    Meteor.call("setAccountSetting", token, "ldap", false, instance.setAccountSettingCallback);
  },

  "click .idp-modal-save"(evt) {
    // TODO(soon): refactor the backend to make this a single Meteor call, and an atomic DB write.
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");

    // A list of settings to save with the setSetting method, in order.
    const settingsToSave = [
      { name: "ldapUrl",                value: instance.ldapUrl.get().trim() },
      { name: "ldapSearchBindDn",       value: instance.ldapSearchBindDn.get().trim() },
      { name: "ldapSearchBindPassword", value: instance.ldapSearchBindPassword.get().trim() },
      { name: "ldapBase",               value: instance.ldapBase.get().trim() },
      { name: "ldapSearchUsername",     value: instance.ldapSearchUsername.get().trim() },
      { name: "ldapNameField",          value: instance.ldapNameField.get().trim() },
      { name: "ldapEmailField",         value: instance.ldapEmailField.get().trim() },
      { name: "ldapFilter",             value: instance.ldapFilter.get().trim() },
      { name: "ldapCaCert",             value: instance.ldapCaCert.get().trim() },
    ];

    const saveSettings = function (settingList, errback, callback) {
      const setting = settingList[0];
      Meteor.call("setSetting", token, setting.name, setting.value, (err) => {
        if (err) {
          errback(err);
        } else {
          settingList.shift();
          if (settingList.length === 0) {
            callback();
          } else {
            saveSettings(settingList, errback, callback);
          }
        }
      });
    };

    saveSettings(settingsToSave,
      (err) => { instance.errorMessage.set(err.message); },

      () => {
        // ldap requires the "setAccountSetting" method, so it's separated out here.
        Meteor.call("setAccountSetting", token, "ldap", true, instance.setAccountSettingCallback);
      }
    );
  },

  "click .idp-modal-cancel"(evt) {
    const instance = Template.instance();
    // double invocation because there's no way to pass a callback function around in Blaze without
    // invoking it, and we need to pass it to modalDialogWithBackdrop
    instance.data.onDismiss()();
  },
});

// SAML form.
Template.adminIdentityProviderConfigureSaml.onCreated(function () {
  const samlEntryPoint = globalDb.getSamlEntryPoint();
  const samlPublicCert = globalDb.getSamlPublicCert();
  const samlEntityId = globalDb.getSamlEntityId() || window.location.hostname;

  this.samlEntryPoint = new ReactiveVar(samlEntryPoint);
  this.samlPublicCert = new ReactiveVar(samlPublicCert);
  this.samlEntityId = new ReactiveVar(samlEntityId);
  this.errorMessage = new ReactiveVar(undefined);
  this.formChanged = new ReactiveVar(false);
  this.setAccountSettingCallback = setAccountSettingCallback.bind(this);
});

Template.adminIdentityProviderConfigureSaml.onRendered(function () {
  // Focus the first input when the form is shown.
  this.find("input").focus();
});

Template.adminIdentityProviderConfigureSaml.helpers({
  samlEnabled() {
    return globalDb.getSettingWithFallback("saml", false);
  },

  samlEntryPoint() {
    const instance = Template.instance();
    return instance.samlEntryPoint.get();
  },

  samlPublicCert() {
    const instance = Template.instance();
    return instance.samlPublicCert.get();
  },

  samlEntityId() {
    const instance = Template.instance();
    return instance.samlEntityId.get();
  },

  saveDisabled() {
    const instance = Template.instance();
    const samlEnabled = globalDb.getSettingWithFallback("saml", false);
    return (samlEnabled && !instance.formChanged.get()) || !instance.samlEntryPoint.get() || !instance.samlPublicCert.get() || !instance.samlEntityId.get();
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },

  exampleEntityId() {
    return window.location.hostname;
  },

  serviceUrl() {
    return Meteor.absoluteUrl("_saml/validate/default");
  },

  configUrl() {
    return Meteor.absoluteUrl("_saml/config/default");
  },
});

Template.adminIdentityProviderConfigureSaml.events({
  "input input[name=entryPoint]"(evt) {
    const instance = Template.instance();
    instance.samlEntryPoint.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input textarea[name=publicCert]"(evt) {
    const instance = Template.instance();
    instance.samlPublicCert.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=entityId]"(evt) {
    const instance = Template.instance();
    instance.samlEntityId.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "click .idp-modal-disable"(evt) {
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");
    Meteor.call("setAccountSetting", token, "saml", false, instance.setAccountSettingCallback);
  },

  "click .idp-modal-save"(evt) {
    const instance = Template.instance();
    const samlEntryPoint = instance.samlEntryPoint.get().trim();
    const samlPublicCert = instance.samlPublicCert.get().trim();
    const samlEntityId = instance.samlEntityId.get().trim();
    const token = Iron.controller().state.get("token");
    // TODO: rework this into a single Meteor method call.
    Meteor.call("setSetting", token, "samlEntryPoint", samlEntryPoint, (err) => {
      if (err) {
        instance.errorMessage.set(err.message);
      } else {
        Meteor.call("setSetting", token, "samlPublicCert", samlPublicCert, (err) => {
          if (err) {
            instance.errorMessage.set(err.message);
          } else {
            Meteor.call("setSetting", token, "samlEntityId", samlEntityId, (err) => {
              if (err) {
                instance.errorMessage.set(err.message);
              } else {
                Meteor.call("setAccountSetting", token, "saml", true, instance.setAccountSettingCallback);
              }
            });
          }
        });
      }
    });
  },

  "click .idp-modal-cancel"(evt) {
    const instance = Template.instance();
    // double invocation because there's no way to pass a callback function around in Blaze without
    // invoking it, and we need to pass it to modalDialogWithBackdrop
    instance.data.onDismiss()();
  },
});
