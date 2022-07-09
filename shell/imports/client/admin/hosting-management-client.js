import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { ReactiveVar } from "meteor/reactive-var";

import { globalDb } from "/imports/db-deprecated";

const DEFAULT_QUOTA_ENABLED = false;
const DEFAULT_QUOTA_LDAP_ATTRIBUTE = "quota";
const DEFAULT_BILLING_PROMPT_URL = "";

Template.newAdminHostingManagement.onCreated(function () {
  this.quotaEnabled = new ReactiveVar(globalDb.getSettingWithFallback("quotaEnabled",
    DEFAULT_QUOTA_ENABLED));
  this.quotaLdapAttribute = new ReactiveVar(globalDb.getSettingWithFallback(
    "quotaLdapAttribute", DEFAULT_QUOTA_LDAP_ATTRIBUTE));
  this.billingPromptUrl = new ReactiveVar(globalDb.getSettingWithFallback(
    "billingPromptUrl", DEFAULT_BILLING_PROMPT_URL));
  this.formChanged = new ReactiveVar(false);
  this.formState = new ReactiveVar({
    state: "edit", // Other allowed states: "submitting", "success", and "error"
    message: undefined,
  });
});

Template.newAdminHostingManagement.helpers({
  hasError() {
    const instance = Template.instance();
    return instance.formState.get().state === "error";
  },

  hasSuccess() {
    const instance = Template.instance();
    return instance.formState.get().state === "success";
  },

  message() {
    const instance = Template.instance();
    return instance.formState.get().message;
  },

  quotaEnabled: function () {
    const instance = Template.instance();
    return instance.quotaEnabled.get();
  },

  quotaLdapAttribute: function () {
    const instance = Template.instance();
    return instance.quotaLdapAttribute.get();
  },

  billingPromptUrl: function () {
    const instance = Template.instance();
    return instance.billingPromptUrl.get();
  },
});

Template.newAdminHostingManagement.events({
  "submit .admin-hosting-management-form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
  },

  "click input[name=quotaEnabled]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.quotaEnabled.set(!instance.quotaEnabled.get());
    instance.formChanged.set(true);
  },

  "input input[name=quotaLdapAttribute]"(evt) {
    const instance = Template.instance();
    instance.quotaLdapAttribute.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "input input[name=billingPromptUrl]"(evt) {
    const instance = Template.instance();
    instance.billingPromptUrl.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "click .save"(evt) {
    const instance = Template.instance();
    const quotaEnabled = instance.quotaEnabled.get();
    const quotaLdapAttribute = instance.quotaLdapAttribute.get();
    const billingPromptUrl = instance.billingPromptUrl.get();

    instance.formState.set({
      state: "submitting",
      message: "",
    });

    Meteor.call("setSetting", undefined, "quotaEnabled", quotaEnabled, (err) => {
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
      } else {
        // For now, enabling quota implies enabling LDAP based quota
        Meteor.call("setSetting", undefined, "quotaLdapEnabled", quotaEnabled, (err) => {
          if (err) {
            instance.formState.set({
              state: "error",
              message: err.message,
            });
          } else {
            Meteor.call("setSetting", undefined, "quotaLdapAttribute", quotaLdapAttribute,
            (err) => {
              if (err) {
                instance.formState.set({
                  state: "error",
                  message: err.message,
                });
              } else {
                Meteor.call("setSetting", undefined, "billingPromptUrl", billingPromptUrl,
                (err) => {
                  if (err) {
                    instance.formState.set({
                      state: "error",
                      message: err.message,
                    });
                  } else {
                    instance.formChanged.set(false);
                    instance.formState.set({
                      state: "success",
                      message: "Saved changes.",
                    });
                  }
                });
              }
            });
          }
        });
      }
    });
  },

  "click .restore"(evt) {
    const instance = Template.instance();
    instance.quotaEnabled.set(DEFAULT_QUOTA_ENABLED);
    instance.quotaLdapAttribute.set(DEFAULT_QUOTA_LDAP_ATTRIBUTE);
    instance.billingPromptUrl.set(DEFAULT_BILLING_PROMPT_URL);
  },
});
