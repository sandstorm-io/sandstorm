/* globals getToken, globalDb */

Template.newAdminEmailConfig.onCreated(function () {
  const c = globalDb.getSmtpConfig();
  this.hostname = new ReactiveVar(c && c.hostname || "");
  this.port = new ReactiveVar(c && c.port || "25");
  this.username = new ReactiveVar(c && c.auth && c.auth.user || "");
  this.password = new ReactiveVar(c && c.auth && c.auth.pass || "");
  this.returnAddress = new ReactiveVar(c && c.returnAddress || ("support@" + window.location.hostname));
  this.state = new ReactiveVar("default");
  this.errorMessage = new ReactiveVar("");
});

Template.newAdminEmailConfig.helpers({
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

  isFormSubmitting() {
    const instance = Template.instance();
    return instance.state.get() === "submitting";
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
});

const extractDataFromForm = (instance) => {
  const hostname = instance.hostname.get();
  const port = parseInt(instance.port.get());
  const user = instance.username.get();
  const pass = instance.password.get();
  const returnAddress = instance.returnAddress.get();
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

Template.newAdminEmailConfig.events({
  "submit .email-form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    const token = getToken();
    const formData = extractDataFromForm(instance);
    Meteor.call("setSmtpConfig", token && token._token, formData, (err) => {
      if (err) {
        instance.errorMessage.set(err.toString());
        instance.state.set("error");
      } else {
        instance.state.set("success");
      }
    });
    instance.state.set("submitting");
  },
});
