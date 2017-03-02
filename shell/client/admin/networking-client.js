// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2017 Sandstorm Development Group, Inc. and contributors
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

import { PRIVATE_IPV4_ADDRESSES, PRIVATE_IPV6_ADDRESSES } from "/imports/constants.js";

const DEFAULT_IP_BLACKLIST = PRIVATE_IPV4_ADDRESSES.concat(PRIVATE_IPV6_ADDRESSES).join("\n");

Template.newAdminNetworking.onCreated(function () {
  this.originalIpBlacklist = globalDb.getSettingWithFallback("ipBlacklist", "");
  this.ipBlacklist = new ReactiveVar(this.originalIpBlacklist);
  this.formState = new ReactiveVar({
    state: "edit", // Other allowed states: "submitting", "success", and "error"
    message: undefined,
  });
});

Template.newAdminNetworking.helpers({
  ipBlacklist() {
    const instance = Template.instance();
    return instance.ipBlacklist.get();
  },

  saveDisabled() {
    const instance = Template.instance();
    return instance.formState.get().state === "submitting" ||
           instance.ipBlacklist.get() === instance.originalIpBlacklist;
  },

  restoreDisabled() {
    const instance = Template.instance();
    return instance.ipBlacklist.get() === DEFAULT_IP_BLACKLIST;
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
});

Template.newAdminNetworking.events({
  "submit .admin-networking"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
  },

  "input textarea.ip-blacklist"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.ipBlacklist.set(evt.currentTarget.value);
  },

  "click .save"(evt) {
    const instance = Template.instance();
    const newIpBlacklist = instance.ipBlacklist.get();

    instance.formState.set({
      state: "submitting",
      message: "",
    });

    Meteor.call("setSetting", undefined, "ipBlacklist", newIpBlacklist, (err) => {
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
      } else {
        instance.originalIpBlacklist = newIpBlacklist;
        instance.formState.set({
          state: "success",
          message: "Saved changes.",
        });
      }
    });
  },

  "click .restore"(evt) {
    const instance = Template.instance();
    instance.ipBlacklist.set(DEFAULT_IP_BLACKLIST);
  },
});
