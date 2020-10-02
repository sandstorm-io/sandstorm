// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

// TODO(someday): split out fields by locus
// isEnabled is available on both client and server
// getLoginId is only used on server
// initiateLogin and loginTemplate are only used on client

import { Meteor } from "meteor/meteor";
import { Accounts } from "meteor/accounts-base";
import { globalDb } from "/imports/db-deprecated.js";

function serviceEnabled(name) {
  const setting = globalDb.collections.settings.findOne({ _id: name });
  return setting && !!setting.value;
}

Accounts.loginServices.oidc = {
  isEnabled: function () {
    return serviceEnabled("oidc");
  },

  getLoginId: function (identity) {
    return identity.services.oidc.id;
  },

  initiateLogin: function (_loginId) {
    Meteor.loginWithOidc();
    return { oneClick: true };
  },

  loginTemplate: {
    name: "oauthLoginButton",
    priority: 30,
    data: {
      method: "loginWithOidc",
      name: "oidc",
      displayName: "OpenID Connect",
      linkingNewCredential: false,
    },
  },
};

Accounts.loginServices.github = {
  isEnabled: function () {
    return serviceEnabled("github");
  },

  getLoginId: function (identity) {
    return identity.services.github.username;
  },

  initiateLogin: function (_loginId) {
    Meteor.loginWithGithub();
    return { oneClick: true };
  },

  loginTemplate: {
    name: "oauthLoginButton",
    priority: 1,
    data: {
      method: "loginWithGithub",
      name: "github",
      displayName: "GitHub",
      linkingNewCredential: false,
    },
  },
};

Accounts.loginServices.google = {
  isEnabled: function () {
    return serviceEnabled("google");
  },

  getLoginId: function (identity) {
    return identity.services.google.email;
  },

  initiateLogin: function (loginId) {
    Meteor.loginWithGoogle({ loginHint: loginId });
    return { oneClick: true };
  },

  loginTemplate: {
    name: "oauthLoginButton",
    priority: 2,
    data: {
      method: "loginWithGoogle",
      name: "google",
      displayName: "Google",
      linkingNewCredential: false,
    },
  },
};

Accounts.loginServices.email = {
  isEnabled: function () {
    return serviceEnabled("emailToken");
  },

  getLoginId: function (identity) {
    return identity.services.email.email;
  },

  initiateLogin: function (_loginId) {
    return { form: true };
  },

  loginTemplate: {
    name: "emailLoginForm",
    priority: 10,
  },
};

Accounts.loginServices.ldap = {
  isEnabled: function () {
    return serviceEnabled("ldap");
  },

  getLoginId: function (identity) {
    return identity.services.ldap.username;
  },

  initiateLogin: function (_loginId) {
    return { form: true };
  },

  loginTemplate: {
    name: "ldapLoginForm",
    priority: 21, // Put it at the bottom of the list.
  },
};

Accounts.loginServices.saml = {
  isEnabled: function () {
    return serviceEnabled("saml");
  },

  getLoginId: function (identity) {
    return identity.services.saml.id;
  },

  initiateLogin: function (_loginId) {
    Meteor.loginWithSaml();
    return { oneClick: true };
  },

  loginTemplate: {
    name: "samlLoginForm",
    priority: 20, // Put it at the bottom of the list.
  },
};

Accounts.loginServices.demo = {
  isEnabled: function () {
    return false; // You can never authenticate as a demo user.
  },

  getLoginId: function (identity) {
    return identity._id;
  },

  initiateLogin: function (_loginId) {
    return { demoCannotLogin: true };
  },

  loginTemplate: {},
};
