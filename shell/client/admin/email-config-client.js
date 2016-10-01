/* globals globalDb */

Template.newAdminEmailConfig.onCreated(function () {
  const c = globalDb.getSmtpConfig();
  this.hostname = new ReactiveVar(c && c.hostname || "");
  this.port = new ReactiveVar(c && c.port || "25");
  this.username = new ReactiveVar(c && c.auth && c.auth.user || "");
  this.password = new ReactiveVar(c && c.auth && c.auth.pass || "");
  this.returnAddress = new ReactiveVar(c && c.returnAddress || ("support@" + window.location.hostname));
  this.state = new ReactiveVar("default");
  this.errorMessage = new ReactiveVar("");
  this.showTestSendEmailPopup = new ReactiveVar(false);
  this.showConfirmDisableEmailPopup = new ReactiveVar(false);
  this.formChanged = new ReactiveVar(false);
  this.getSmtpConfig = () => {
    const hostname = this.hostname.get().trim();
    const port = parseInt(this.port.get());
    const user = this.username.get().trim();
    const pass = this.password.get().trim();
    const returnAddress = this.returnAddress.get().trim();
    const formData = {
      hostname,
      port,
      auth: {
        user,
        pass,
      },
      returnAddress,
    };
    return formData;
  };

  this.isDefinitelyInvalid = () => {
    return (
        !this.hostname.get() ||
        !this.port.get() ||
        !this.returnAddress.get()
        );
  };
});

Template.newAdminEmailConfig.helpers({
  emailUnconfigured() {
    // Derive this from the config directly, rather than the locally-modified state.
    const c = globalDb.getSmtpConfig();
    return (!c.hostname || !c.port || !c.returnAddress);
  },

  hostname() {
    const instance = Template.instance();
    return instance.hostname.get();
  },

  port() {
    const instance = Template.instance();
    return instance.port.get();
  },

  username() {
    const instance = Template.instance();
    return instance.username.get();
  },

  password() {
    const instance = Template.instance();
    return instance.password.get();
  },

  returnAddress() {
    const instance = Template.instance();
    return instance.returnAddress.get();
  },

  hasError() {
    const instance = Template.instance();
    return instance.state.get() === "error";
  },

  hasSuccess() {
    const instance = Template.instance();
    return instance.state.get() === "success";
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },

  testDisabled() {
    const instance = Template.instance();
    return instance.isDefinitelyInvalid();
  },

  saveDisabled() {
    const instance = Template.instance();
    const emailLoginSetting = globalDb.collections.settings.findOne({ _id: "emailToken" });
    const emailLoginEnabled = emailLoginSetting ? emailLoginSetting.value : false;
    return emailLoginEnabled && instance.isDefinitelyInvalid() || instance.state.get() === "submitting" || !instance.formChanged.get();
  },

  disableDisabled() {
    const instance = Template.instance();
    return instance.state.get() === "submitting" || !instance.hostname.get();
  },

  showTestSendEmailPopup() {
    const instance = Template.instance();
    return instance.showTestSendEmailPopup.get();
  },

  showConfirmDisableEmailPopup() {
    const instance = Template.instance();
    return instance.showConfirmDisableEmailPopup.get();
  },

  closeTestPopupCallback() {
    const instance = Template.instance();
    return () => {
      instance.showTestSendEmailPopup.set(false);
    };
  },

  closeConfirmDisableEmailPopupCallback() {
    const instance = Template.instance();
    return (clearHostname) => {
      instance.showConfirmDisableEmailPopup.set(false);
      if (clearHostname) {
        instance.hostname.set("");
      }
    };
  },

  getSmtpConfig() {
    const instance = Template.instance();
    return instance.getSmtpConfig();
  },
});

Template.newAdminEmailConfig.events({
  "input input[name=hostname]"(evt) {
    const instance = Template.instance();
    instance.hostname.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=port]"(evt) {
    const instance = Template.instance();
    instance.port.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=username]"(evt) {
    const instance = Template.instance();
    instance.username.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=password]"(evt) {
    const instance = Template.instance();
    instance.password.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=return-address]"(evt) {
    const instance = Template.instance();
    instance.returnAddress.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "submit .email-form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    const formData = instance.getSmtpConfig();
    Meteor.call("setSmtpConfig", undefined, formData, (err) => {
      if (err) {
        instance.errorMessage.set(err.message);
        instance.state.set("error");
      } else {
        instance.state.set("success");
        instance.formChanged.set(false);
      }
    });
    instance.state.set("submitting");
  },

  "click .test"(evt) {
    const instance = Template.instance();
    instance.showTestSendEmailPopup.set(true);
  },

  "click button.disable"(evt) {
    const instance = Template.instance();
    instance.showConfirmDisableEmailPopup.set(true);
  },
});

// Email test popup
Template.emailTestPopup.onCreated(function () {
  this.testAddress = new ReactiveVar("");
  this.formStatus = new ReactiveVar({
    state: "input",
    message: undefined,
  });
});

Template.emailTestPopup.onRendered(function () {
  this.find("input").focus();
});

Template.emailTestPopup.helpers({
  testAddress() {
    const instance = Template.instance();
    return instance.testAddress.get();
  },

  hasError() {
    const instance = Template.instance();
    const state = instance.formStatus.get();
    return state && state.state === "error";
  },

  hasSuccess() {
    const instance = Template.instance();
    const state = instance.formStatus.get();
    return state && state.state === "success";
  },

  isSubmitting() {
    const instance = Template.instance();
    const state = instance.formStatus.get();
    return state && state.state === "submitting";
  },

  message() {
    const instance = Template.instance();
    const state = instance.formStatus.get();
    return state && state.message;
  },

  htmlDisabled() {
    const instance = Template.instance();
    const state = instance.formStatus.get();
    if (state.state === "submitting") {
      return "disabled";
    }

    return instance.testAddress.get() ? "" : "disabled";
  },
});

Template.emailTestPopup.events({
  "input input.test-address"(evt) {
    const instance = Template.instance();
    instance.testAddress.set(evt.currentTarget.value);
  },

  "submit form.email-test-form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.formStatus.set({
      state: "submitting",
      message: undefined,
    });
    const testAddress = instance.testAddress.get().trim();
    Meteor.call("testSend", instance.data.token, instance.data.smtpConfig, testAddress, (err) => {
      if (err) {
        instance.formStatus.set({
          state: "error",
          message: err.message,
        });
      } else {
        instance.formStatus.set({
          state: "success",
          message: `Sent a test email to ${testAddress}.  It should arrive shortly.`,
        });
      }
    });
  },

  "click button.close-dialog"(evt) {
    const instance = Template.instance();
    instance.data.onDismiss && instance.data.onDismiss();
  },
});

Template.emailDisablePopup.onCreated(function () {
  this.state = new ReactiveVar("idle");
  this.errorMessage = new ReactiveVar(undefined);
});

Template.emailDisablePopup.helpers({
  hasError() {
    return !!Template.instance().errorMessage.get();
  },

  message() {
    return Template.instance().errorMessage.get();
  },

  htmlDisabled() {
    const instance = Template.instance();
    const state = instance.state.get();
    if (state.state === "submitting") {
      return "disabled";
    }

    return "";
  },
});

Template.emailDisablePopup.events({
  "click button[name=disable-email]"(evt) {
    const instance = Template.instance();
    instance.state.set("submitting");
    Meteor.call("disableEmail", instance.data.token, (err) => {
      if (err) {
        instance.errorMessage.set(err.message);
        instance.state.set("idle");
      } else {
        instance.data.onDismiss && instance.data.onDismiss(true);
      }
    });
  },

  "click button[name=close-dialog]"(evt) {
    const instance = Template.instance();
    instance.data.onDismiss && instance.data.onDismiss(false);
  },
});
