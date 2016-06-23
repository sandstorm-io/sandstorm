import { DEFAULT_SIGNUP_DIALOG } from "/imports/client/personalization.js";

Template.newAdminPersonalization.onCreated(function () {
  this.serverTitle = new ReactiveVar(globalDb.getSettingWithFallback("serverTitle", ""));
  this.splashUrl = new ReactiveVar(globalDb.getSettingWithFallback("splashUrl", ""));
  this.signupDialog = new ReactiveVar(globalDb.getSettingWithFallback("signupDialog", DEFAULT_SIGNUP_DIALOG));
  this.termsOfServiceUrl = new ReactiveVar(globalDb.getSetting("termsUrl"));
  this.privacyPolicyUrl = new ReactiveVar(globalDb.getSetting("privacyUrl"));

  this.formState = new ReactiveVar("default");
  this.message = new ReactiveVar("");
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
