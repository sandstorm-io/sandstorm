// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2020 Sandstorm Development Group, Inc. and contributors
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

import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { ReactiveVar } from "meteor/reactive-var";
import { globalDb } from "/imports/db-deprecated.js";

Template.newAdminCertificates.onCreated(function () {
  this.formState = new ReactiveVar({
    state: "edit", // Other allowed states: "submitting", "success", and "error"
    message: undefined,
  });

  this.modalState = new ReactiveVar(null);
});

const DNS_PROVIDERS = {
  "cloudflare": "Cloudflare",
  "digitalocean": "Digital Ocean",
  "dnsimple": "DNSimple",
  "duckdns": "DuckDNS",
  "godaddy": "GoDaddy",
  "gandi": "Gandi",
  "namecheap": "NameCheap",
  "namedotcom": "Name.com",
  "route53": "Route53 (AWS)",
  "vultr": "Vultr",
};

Template.newAdminCertificates.helpers({
  saveDisabled() {
    const instance = Template.instance();
    return instance.formState.get().state === "submitting" ||
           instance.ipBlacklist.get() === instance.originalIpBlacklist;
  },

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

  acmeAccount() {
    return globalDb.getSetting("acmeAccount");
  },

  acmeChallenge() {
    return globalDb.getSetting("acmeChallenge");
  },

  modal() {
    const instance = Template.instance();
    return instance.modalState.get();
  },

  onDismiss() {
    const instance = Template.instance();
    return () => {
      instance.modalState.set(null);
    };
  },

  dnsOptions() {
    let result = [];
    for (let name in DNS_PROVIDERS) {
      result.push({module: name, title: DNS_PROVIDERS[name]});
    }
    return result;
  },

  selectedModule() {
    const instance = Template.instance();
    return instance.modalState.get().chooseDns.module;
  },

  expires() {
    let status = globalDb.getSetting("tlsStatus");
    return status && status.expires;
  },

  renewAt() {
    let status = globalDb.getSetting("tlsStatus");
    return status && status.renewAt;
  },

  currentlyRenewing() {
    let status = globalDb.getSetting("tlsStatus");
    return status && status.currentlyRenewing;
  },
});

Template.newAdminCertificates.events({
  "click button.create-account"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.modalState.set({createAccount: {}});
  },

  "click button.forget-acme-account"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    Meteor.call("forgetAcmeAccount", null, (err) => {
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
      }
    });
  },

  "submit form.create-account"(evt) {
    evt.preventDefault();
    evt.stopPropagation();

    const instance = Template.instance();
    let directory = evt.currentTarget.directory.value;
    let email = evt.currentTarget.email.value;

    if (!email.match(/.*@.*/)) {
      alert("Please enter an e-mail address.");
      return;
    }

    instance.modalState.set({createAccount: {loading: true}});

    Meteor.call("fetchAcmeDirectory", null, directory, (err, result) => {
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
        instance.modalState.set(null);
        return;
      }

      instance.modalState.set({createAccount: {
        directory, email,
        queryTos: true,
        tosUrl: (result.meta && result.meta.termsOfService) || ""
      }});
    });
  },

  "click button.agree-acme-tos"(evt) {
    evt.preventDefault();
    evt.stopPropagation();

    const instance = Template.instance();
    let state = instance.modalState.get().createAccount;

    state.loading = true;
    instance.modalState.set({createAccount: state});

    Meteor.call("createAcmeAccount", null, state.directory, state.email, true, (err, result) => {
      instance.modalState.set(null);
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
        instance.modalState.set(null);
      }
    });
  },

  "click button.configure-dns"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.modalState.set({chooseDns: {module: Object.keys(DNS_PROVIDERS)[0]}});
  },

  "click button.forget-dns"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    Meteor.call("forgetAcmeChallenge", null, (err) => {
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
      }
    });
  },

  "change form.choose-dns select.choose-module"(evt) {
    const instance = Template.instance();
    instance.modalState.set({chooseDns: {module: evt.currentTarget.value}});
  },

  "submit form.choose-dns"(evt) {
    evt.preventDefault();
    evt.stopPropagation();

    const instance = Template.instance();
    let module = evt.currentTarget.module.value;
    let optionsJson = evt.currentTarget.options.value;

    let options;
    try {
      options = JSON.parse(optionsJson);
    } catch (err) {
      alert("Invalid JSON: " + err.message);
      return;
    }

    instance.modalState.set({chooseDns: {loading: true}});

    Meteor.call("setAcmeChallenge", null, module, options, (err, result) => {
      instance.modalState.set(null);
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
        instance.modalState.set(null);
      }
    });
  },

  "click button.fetch-cert-now"(evt) {
    const instance = Template.instance();
    Meteor.call("renewCertificateNow", null, (err, result) => {
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
        instance.modalState.set(null);
      } else {
        instance.formState.set({
          state: "success",
          message: "Certificate renewed.",
        });
      }
    });
  },

  async "submit form.manual-upload"(evt) {
    evt.preventDefault();
    evt.stopPropagation();

    const instance = Template.instance();
    let keyInput = evt.currentTarget.key;
    let certInput = evt.currentTarget.cert;

    if (keyInput.files.length != 1) {
      alert("Please choose a key file.");
      return;
    }
    if (certInput.files.length != 1) {
      alert("Please choose a certificate file.");
      return;
    }

    let key = await keyInput.files[0].text();
    let certChain = await certInput.files[0].text();

    if (!certChain.match(/-- *BEGIN CERTIFICATE *--/)) {
      alert("This doesn't look like a valid certificate file. Please provide a PEM-format " +
          "certificate. The file should begin with something like " +
          "'-------BEGIN CERTIFICATE-------'.");
      return;
    }
    if (!key.match(/-- *BEGIN [A-Z0-9 ]*PRIVATE KEY *--/)) {
      alert("This doesn't look like a valid private key file. Please provide a PEM-format " +
          "key. The file should begin with something like '-------BEGIN RSA PRIVATE KEY-------'.");
      return;
    }

    instance.formState.set({
      state: "submitting",
      message: "",
    });

    Meteor.call("setTlsKeys", null, {key, certChain}, (err, result) => {
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
        instance.modalState.set(null);
      } else {
        instance.formState.set({
          state: "success",
          message: "Certificate updated.",
        });
      }
    });
  }
});

Meteor.methods({
  // Client-side prediction.
  forgetAcmeAccount: function () {
    globalDb.collections.settings.remove({ _id: "acmeAccount" });
  },
  forgetAcmeChallenge: function () {
    globalDb.collections.settings.remove({ _id: "acmeChallenge" });
  },
  renewCertificateNow: function () {
    globalDb.collections.settings.upsert({_id: "tlsStatus"},
        {$set: {"value.currentlyRenewing": true}});
  },
});
