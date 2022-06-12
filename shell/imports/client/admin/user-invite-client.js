import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { ReactiveVar } from "meteor/reactive-var";
import { Router } from "meteor/iron:router";

import { globalDb } from "/imports/db-deprecated";

Template.newAdminUserInviteLink.onCreated(function () {
  this.formState = new ReactiveVar("default");
  this.generatedLink = new ReactiveVar(undefined);
  this.message = new ReactiveVar("");
});

Template.newAdminUserInviteLink.helpers({
  hasSuccess() {
    const instance = Template.instance();
    return instance.formState.get() === "success";
  },

  hasError() {
    const instance = Template.instance();
    return instance.formState.get() === "error";
  },

  message() {
    const instance = Template.instance();
    return instance.message.get();
  },

  generatedLink() {
    const instance = Template.instance();
    return instance.generatedLink.get();
  },
});

Template.newAdminUserInviteLink.events({
  "submit .admin-invite-button-form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.formState.set("submitting");
    // token, note, quota
    Meteor.call("createSignupKey", undefined, "", undefined, (err, key) => {
      if (err) {
        instance.formState.set("error");
        instance.message.set(err.message);
      } else {
        instance.formState.set("default");
        instance.message.set("");
        instance.generatedLink.set(getOrigin() + Router.routes.signup.path({ key }));
      }
    });
  },
});

Template.newAdminUserInviteEmail.onCreated(function () {
  this.toAddresses = new ReactiveVar("");
  this.subject = new ReactiveVar("Invitation to Sandstorm on " + document.location.host);
  this.messageBody = new ReactiveVar("Click on the following link to get access to my Sandstorm.io server.\n\n $KEY");

  this.formState = new ReactiveVar("default");
  this.message = new ReactiveVar("");
});

const emailConfigured = function () {
  const smtpConfig = globalDb.getSmtpConfig();
  return !!(smtpConfig && smtpConfig.hostname && smtpConfig.port && smtpConfig.returnAddress);
};

Template.newAdminUserInviteEmail.helpers({
  emailConfigured() {
    return emailConfigured();
  },

  emailFormDisabled() {
    const instance = Template.instance();
    return (
      instance.formState.get() === "submitting" ||
      !emailConfigured()
    );
  },

  sendButtonDisabled() {
    const instance = Template.instance();
    return (
      instance.formState.get() === "submitting" ||
      !instance.toAddresses.get() ||
      !instance.subject.get() ||
      !instance.messageBody.get()
    );
  },

  toAddresses() {
    const instance = Template.instance();
    return instance.toAddresses.get();
  },

  subject() {
    const instance = Template.instance();
    return instance.subject.get();
  },

  messageBody() {
    const instance = Template.instance();
    return instance.messageBody.get();
  },

  hasSuccess() {
    const instance = Template.instance();
    return instance.formState.get() === "success";
  },

  hasError() {
    const instance = Template.instance();
    return instance.formState.get() === "error";
  },

  message() {
    const instance = Template.instance();
    return instance.message.get();
  },
});

Template.newAdminUserInviteEmail.events({
  "input textarea[name=to-addresses]"(evt) {
    const instance = Template.instance();
    instance.toAddresses.set(evt.currentTarget.value);
  },

  "input input[name=subject]"(evt) {
    const instance = Template.instance();
    instance.subject.set(evt.currentTarget.value);
  },

  "input textarea[name=message-body]"(evt) {
    const instance = Template.instance();
    instance.messageBody.set(evt.currentTarget.value);
  },

  "submit .admin-invite-email-form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    const origin = getOrigin();
    const from = globalDb.getReturnAddressWithDisplayName(Meteor.userId());
    const list = instance.toAddresses.get();
    const subject = instance.subject.get();
    const message = instance.messageBody.get();
    instance.formState.set("submitting");
    // token, origin, from, list, subject, message, quota
    Meteor.call("sendInvites", undefined, origin, from, list, subject, message, undefined, (err) => {
      if (err) {
        instance.formState.set("error");
        instance.message.set(err.message);
      } else {
        instance.formState.set("success");
        instance.message.set("Sent invitation(s) successfully.");
        instance.toAddresses.set("");
      }
    });
  },
});
