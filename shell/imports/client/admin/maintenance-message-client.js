import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";

import { globalDb } from "/imports/db-deprecated.js";

Template.newAdminMaintenance.onCreated(function () {
  const messageText = globalDb.getSettingWithFallback("adminAlert", "");
  const maintenanceTime = globalDb.getSettingWithFallback("adminAlertTime", "");
  const linkUrl = globalDb.getSettingWithFallback("adminAlertUrl", "");

  this.messageText = new ReactiveVar(messageText);
  this.maintenanceTime = new ReactiveVar(maintenanceTime);
  this.linkUrl = new ReactiveVar(linkUrl);
  this.formChanged = new ReactiveVar(false);
  this.formState = new ReactiveVar({
    state: "editing",
    message: undefined,
  });
});

Template.newAdminMaintenance.helpers({
  messageText() {
    const instance = Template.instance();
    return instance.messageText.get();
  },

  maintenanceTime() {
    const instance = Template.instance();
    return instance.maintenanceTime.get();
  },

  linkUrl() {
    const instance = Template.instance();
    return instance.linkUrl.get();
  },

  exampleDate() {
    return (new Date()).toString();
  },

  saveDisabled() {
    const instance = Template.instance();
    return instance.formState.get().state === "submitting" || !instance.formChanged.get();
  },

  hasSuccess() {
    const instance = Template.instance();
    return instance.formState.get().state === "success";
  },

  hasError() {
    const instance = Template.instance();
    return instance.formState.get().state === "error";
  },

  statusMessage() {
    const instance = Template.instance();
    return instance.formState.get().message;
  },
});

Template.newAdminMaintenance.events({
  "input input[name=message-text]"(evt) {
    const instance = Template.instance();
    instance.messageText.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=maintenance-time]"(evt) {
    const instance = Template.instance();
    instance.maintenanceTime.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=url]"(evt) {
    const instance = Template.instance();
    instance.linkUrl.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "submit form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
  },

  "click .save"(evt) {
    const instance = Template.instance();
    const maintenanceTimeString = instance.maintenanceTime.get();
    // Behavior copied from admin-client.js

    let maintenanceTime = null;
    if (maintenanceTimeString) {
      maintenanceTime = new Date(maintenanceTimeString);
      if (isNaN(maintenanceTime.getTime())) {
        // Assume only time and not date was set.
        maintenanceTime = new Date(new Date().toLocaleDateString() + " " + maintenanceTimeString);
      }

      if (isNaN(maintenanceTime.getTime())) {
        instance.formState.set({
          state: "error",
          message: "Couldn't parse maintenance time, please be more precise.",
        });
        return;
      }
    }

    const params = {
      text: instance.messageText.get(),
      time: maintenanceTime,
      url: instance.linkUrl.get(),
    };
    Meteor.call("setMaintenanceMessage", params, (err) => {
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
      } else {
        instance.formState.set({
          state: "success",
          message: "Saved changes.",
        });
        instance.formChanged.set(false);
      }
    });
  },
});
