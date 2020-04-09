import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { Tracker } from "meteor/tracker";
import { ReactiveVar } from "meteor/reactive-var";

import { globalDb } from "/imports/db-deprecated.js";

Template.newAdminOrganization.onCreated(function () {
  const emailChecked = globalDb.getOrganizationEmailEnabled() || false;
  const gappsChecked = globalDb.getOrganizationGoogleEnabled() || false;
  const ldapChecked = globalDb.getOrganizationLdapEnabled() || false;
  const samlChecked = globalDb.getOrganizationSamlEnabled() || false;

  const emailDomain = globalDb.getOrganizationEmailDomain() || "example.com";
  const gappsDomain = globalDb.getOrganizationGoogleDomain() || "example.com";

  const disallowGuests = globalDb.getOrganizationDisallowGuestsRaw() || false;
  const shareContacts = globalDb.getOrganizationShareContactsRaw() || false;

  this.emailChecked = new ReactiveVar(emailChecked);
  this.emailDomain = new ReactiveVar(emailDomain);
  this.gappsChecked = new ReactiveVar(gappsChecked);
  this.gappsDomain = new ReactiveVar(gappsDomain);
  this.ldapChecked = new ReactiveVar(ldapChecked);
  this.samlChecked = new ReactiveVar(samlChecked);
  this.disallowGuests = new ReactiveVar(disallowGuests);
  this.shareContacts = new ReactiveVar(shareContacts);

  this.formState = new ReactiveVar("default");
  this.message = new ReactiveVar("");
  this.hasChanged = new ReactiveVar(false);
});

const providerEnabled = function (providerString) {
  // TODO(soon): share this with setup wizard
  const setting = globalDb.collections.settings.findOne({ _id: providerString });
  if (setting) {
    return setting.value;
  } else {
    return false;
  }
};

Template.newAdminOrganization.helpers({
  formDisabled() {
    const instance = Template.instance();
    return instance.formState.get() === "submitting";
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

  emailChecked() {
    const instance = Template.instance();
    return instance.emailChecked.get();
  },

  emailDomain() {
    const instance = Template.instance();
    return instance.emailDomain.get();
  },

  emailDisabled() {
    return !providerEnabled("emailToken");
  },

  gappsChecked() {
    const instance = Template.instance();
    return instance.gappsChecked.get();
  },

  gappsDomain() {
    const instance = Template.instance();
    return instance.gappsDomain.get();
  },

  gappsDisabled() {
    return !providerEnabled("google");
  },

  ldapChecked() {
    const instance = Template.instance();
    return instance.ldapChecked.get();
  },

  ldapDisabled() {
    return !providerEnabled("ldap");
  },

  samlChecked() {
    const instance = Template.instance();
    return instance.samlChecked.get();
  },

  samlDisabled() {
    return !providerEnabled("saml");
  },

  disallowGuests() {
    const instance = Template.instance();
    return instance.disallowGuests.get();
  },

  shareContacts() {
    const instance = Template.instance();
    return instance.shareContacts.get();
  },

  saveDisabled() {
    const instance = Template.instance();
    return !instance.hasChanged.get() || instance.formState.get() === "submitting";
  },
});

Template.newAdminOrganization.events({
  "click input[name=email-toggle]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.emailChecked.set(!instance.emailChecked.get());
    instance.hasChanged.set(true);
  },

  "click input[name=gapps-toggle]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.gappsChecked.set(!instance.gappsChecked.get());
    instance.hasChanged.set(true);
  },

  "click input[name=ldap-toggle]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.ldapChecked.set(!instance.ldapChecked.get());
    instance.hasChanged.set(true);
  },

  "click input[name=saml-toggle]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.samlChecked.set(!instance.samlChecked.get());
    instance.hasChanged.set(true);
  },

  "input input[name=email-domain]"(evt) {
    const instance = Template.instance();
    instance.emailDomain.set(evt.currentTarget.value);
    instance.hasChanged.set(true);
  },

  "input input[name=gapps-domain]"(evt) {
    const instance = Template.instance();
    instance.gappsDomain.set(evt.currentTarget.value);
    instance.hasChanged.set(true);
  },

  "click input[name=disallow-guests]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.disallowGuests.set(!instance.disallowGuests.get());
    instance.hasChanged.set(true);
  },

  "click input[name=share-contacts]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.shareContacts.set(!instance.shareContacts.get());
    instance.hasChanged.set(true);
  },

  "submit .admin-organization-management-form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    const params = {
      membership: {
        emailToken: {
          enabled: instance.emailChecked.get(),
          domain: instance.emailDomain.get(),
        },
        google: {
          enabled: instance.gappsChecked.get(),
          domain: instance.gappsDomain.get(),
        },
        ldap: {
          enabled: instance.ldapChecked.get(),
        },
        saml: {
          enabled: instance.samlChecked.get(),
        },
      },
      settings: {
        disallowGuests: instance.disallowGuests.get(),
        shareContacts: instance.shareContacts.get(),
      },
    };
    instance.formState.set("submitting");
    Meteor.call("saveOrganizationSettings", undefined, params, (err) => {
      if (err) {
        // Force repaint of focusingErrorBox to cause the error to be focused/scrolled on-screen,
        // even if err.message is the same as the previous value.
        instance.formState.set("default");
        instance.message.set(undefined);
        Tracker.flush();
        instance.formState.set("error");
        instance.message.set(err.message);
      } else {
        instance.formState.set("success");
        instance.hasChanged.set(false);
      }
    });
  },
});
