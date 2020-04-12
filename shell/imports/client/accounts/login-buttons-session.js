// forked from Meteor's accounts-ui from
// https://github.com/meteor/meteor/tree/ab9ef40d258bbb9b9de453600495c8337577c565/packages/accounts-ui-unstyled
//
// ========================================
// Meteor is licensed under the MIT License
// ========================================
//
// Copyright (C) 2011--2015 Meteor Development Group
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software
// and associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
// BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
//
// ====================================================================
// This license applies to all code in Meteor that is not an externally
// maintained library. Externally maintained libraries have their own
// licenses, included in the LICENSES directory.
// ====================================================================

import { Accounts } from "meteor/accounts-base";
import { _ } from "meteor/underscore";

const VALID_KEYS = [
  "dropdownVisible",
  "inSignupFlow",

  "errorMessage",
  "infoMessage",
];

const validateKey = function (key) {
  if (!_.contains(VALID_KEYS, key))
    throw new Error("Invalid key in loginButtonsSession: " + key);
};

const KEY_PREFIX = "Meteor.loginButtons.";

// TODO(now): Don't put this under `Accounts`.
Accounts._loginButtonsSession = {
  set: function (key, value) {
    validateKey(key);
    if (_.contains(["errorMessage", "infoMessage"], key))
      throw new Error("Don't set errorMessage or infoMessage directly. Instead, use errorMessage() or infoMessage().");

    this._set(key, value);
  },

  _set: function (key, value) {
    Session.set(KEY_PREFIX + key, value);
  },

  get: function (key) {
    validateKey(key);
    return Session.get(KEY_PREFIX + key);
  },

  closeDropdown: function () {
    this.resetMessages();
    // TODO(now): Close the popup
  },

  infoMessage: function (message) {
    this._set("errorMessage", null);
    this._set("infoMessage", message);
    this.ensureMessageVisible();
  },

  errorMessage: function (message) {
    this._set("errorMessage", message);
    this._set("infoMessage", null);
    this.ensureMessageVisible();
  },

  ensureMessageVisible: function () {
    // TODO(now): Force open popup.
  },

  resetMessages: function () {
    this._set("errorMessage", null);
    this._set("infoMessage", null);
  },
};
