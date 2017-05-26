import { DEFAULT_SIGNUP_DIALOG } from "/imports/client/personalization.js";

Template.newAdminPersonalization.onCreated(function () {
  this.serverTitle = new ReactiveVar(globalDb.getSettingWithFallback("serverTitle", ""));
  this.splashUrl = new ReactiveVar(globalDb.getSettingWithFallback("splashUrl", ""));
  this.signupDialog = new ReactiveVar(globalDb.getSettingWithFallback("signupDialog", DEFAULT_SIGNUP_DIALOG));
  this.termsOfServiceUrl = new ReactiveVar(globalDb.getSettingWithFallback("termsUrl", ""));
  this.privacyPolicyUrl = new ReactiveVar(globalDb.getSettingWithFallback("privacyUrl", ""));

  this.whitelabelCustomLoginProviderName =
    new ReactiveVar(globalDb.getSettingWithFallback("whitelabelCustomLoginProviderName", ""));
  this.whitelabelHideSendFeedback =
    new ReactiveVar(globalDb.getSettingWithFallback("whitelabelHideSendFeedback", false));
  this.whitelabelHideTroubleshooting =
    new ReactiveVar(globalDb.getSettingWithFallback("whitelabelHideTroubleshooting", false));
  this.whiteLabelHideAbout =
    new ReactiveVar(globalDb.getSettingWithFallback("whiteLabelHideAbout", false));
  this.whitelabelUseServerTitleForHomeText =
    new ReactiveVar(globalDb.getSettingWithFallback("whitelabelUseServerTitleForHomeText", false));

  this.formState = new ReactiveVar("default");
  this.message = new ReactiveVar("");

  this.logoError = new ReactiveVar(undefined);
  this._uploadToken = undefined;
  this.doUpload = (token, file) => {
    const staticHost = globalDb.makeWildcardHost("static");
    const path = `${window.location.protocol}//${staticHost}/${token}`;
    HTTP.post(path, { content: file, }, (err, result) => {
      if (err) {
        this.logoError.set(err.message);
      }
    });
  };

  this.doUploadIfReady = () => {
    const input = this.find("input[name='upload-file']");
    const file = input && input.files && input.files[0];
    const token = this._uploadToken;
    if (token && file) {
      input.value = "";
      this._uploadToken = undefined;
      this.doUpload(token, file);
    }
  };
});

Template.newAdminPersonalization.helpers({
  formDisabled() {
    const instance = Template.instance();
    return instance.formState.get() === "submitting";
  },

  serverTitle() {
    const instance = Template.instance();
    return instance.serverTitle.get();
  },

  splashUrl() {
    const instance = Template.instance();
    return instance.splashUrl.get();
  },

  exampleSplashUrl() {
    return window.location.protocol + "//" + globalDb.makeWildcardHost("0a3w6emamtxnncqky840");
  },

  signupDialog() {
    const instance = Template.instance();
    return instance.signupDialog.get();
  },

  termsOfServiceUrl() {
    const instance = Template.instance();
    return instance.termsOfServiceUrl.get();
  },

  privacyPolicyUrl() {
    const instance = Template.instance();
    return instance.privacyPolicyUrl.get();
  },

  logoError() {
    const instance = Template.instance();
    return instance.logoError.get();
  },

  logoUrl() {
    const assetId = globalDb.getSettingWithFallback("whitelabelCustomLogoAssetId", "");
    if (assetId) {
      return `${window.location.protocol}//${globalDb.makeWildcardHost("static")}/${assetId}`;
    }

    return "/sandstorm-gradient-logo.svg";
  },

  hideTroubleshootingChecked() {
    const instance = Template.instance();
    return instance.whitelabelHideTroubleshooting.get();
  },

  hideAboutChecked() {
    const instance = Template.instance();
    return instance.whiteLabelHideAbout.get();
  },

  hideSendFeedbackChecked() {
    const instance = Template.instance();
    return instance.whitelabelHideSendFeedback.get();
  },

  useServerTitleForHomeTextChecked() {
    const instance = Template.instance();
    return instance.whitelabelUseServerTitleForHomeText.get();
  },

  customLoginProviderName() {
    const instance = Template.instance();
    return instance.whitelabelCustomLoginProviderName.get();
  },

  hasError() {
    const instance = Template.instance();
    return instance.formState.get() === "error";
  },

  hasSuccess() {
    const instance = Template.instance();
    return instance.formState.get() === "success";
  },

  message() {
    const instance = Template.instance();
    return instance.message.get();
  },

  serverUrl() {
    return document.location.protocol + "//" + document.location.host;
  },
});

Template.newAdminPersonalization.events({
  "input input[name=server-title]"(evt) {
    const instance = Template.instance();
    instance.serverTitle.set(evt.currentTarget.value);
  },

  "input input[name=splash-url]"(evt) {
    const instance = Template.instance();
    instance.splashUrl.set(evt.currentTarget.value);
  },

  "input input[name=signup-dialog]"(evt) {
    const instance = Template.instance();
    instance.signupDialog.set(evt.currentTarget.value);
  },

  "input input[name=terms-of-service]"(evt) {
    const instance = Template.instance();
    instance.termsOfServiceUrl.set(evt.currentTarget.value);
  },

  "input input[name=privacy-policy]"(evt) {
    const instance = Template.instance();
    instance.privacyPolicyUrl.set(evt.currentTarget.value);
  },

  "click button[name=reset-logo]"(evt) {
    const instance = Template.instance();
    Meteor.call("resetWhitelabelLogo", (err) => {
      if (err) {
        instance.logoError.set(err.message);
      } else {
        instance.logoError.set(undefined);
      }
    });
  },

  "click button[name=upload-logo]"(evt) {
    const instance = Template.instance();
    const input = instance.find("input[name=upload-file]");
    // Clear any file that was already selected.
    input.value = "";

    // Request an upload token from the server.
    Meteor.call("getWhitelabelLogoUploadToken", (err, result) => {
      if (err) {
        instance.logoError.set(err.message);
      } else {
        instance._uploadToken = result;
        instance.doUploadIfReady();
      }
    });

    // Open the file picker.
    input.click();
  },

  "change input[name=upload-file]"(evt) {
    const instance = Template.instance();
    instance.doUploadIfReady();
  },

  "click input[name=hide-troubleshooting]"(evt) {
    const instance = Template.instance();
    instance.whitelabelHideTroubleshooting.set(evt.currentTarget.checked);
  },

  "click input[name=hide-about]"(evt) {
    const instance = Template.instance();
    instance.whiteLabelHideAbout.set(evt.currentTarget.checked);
  },

  "click input[name=hide-send-feedback]"(evt) {
    const instance = Template.instance();
    instance.whitelabelHideSendFeedback.set(evt.currentTarget.checked);
  },

  "click input[name=use-server-title-for-home-text]"(evt) {
    const instance = Template.instance();
    instance.whitelabelUseServerTitleForHomeText.set(evt.currentTarget.checked);
  },

  "input input[name=custom-login-provider-name]"(evt) {
    const instance = Template.instance();
    instance.whitelabelCustomLoginProviderName.set(evt.currentTarget.value);
  },

  "submit form.admin-personalization-form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();

    const options = {
      serverTitle: instance.serverTitle.get(),
      splashUrl: instance.splashUrl.get(),
      signupDialog: instance.signupDialog.get(),
      termsOfServiceUrl: instance.termsOfServiceUrl.get(),
      privacyPolicyUrl: instance.privacyPolicyUrl.get(),
      whitelabelCustomLoginProviderName: instance.whitelabelCustomLoginProviderName.get(),
      whitelabelHideSendFeedback: !!instance.whitelabelHideSendFeedback.get(),
      whitelabelHideTroubleshooting: !!instance.whitelabelHideTroubleshooting.get(),
      whiteLabelHideAbout: !!instance.whiteLabelHideAbout.get(),
      whitelabelUseServerTitleForHomeText: !!instance.whitelabelUseServerTitleForHomeText.get(),
    };

    instance.formState.set("submitting");
    Meteor.call("setPersonalizationSettings", options, (err) => {
      if (err) {
        instance.formState.set("error");
        instance.message.set(err.message);
      } else {
        instance.formState.set("success");
        instance.message.set("Saved changes.");
      }
    });
  },
});
