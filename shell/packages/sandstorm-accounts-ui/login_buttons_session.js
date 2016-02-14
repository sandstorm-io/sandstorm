const VALID_KEYS = [
  "dropdownVisible",
  "inSignupFlow",

  "errorMessage",
  "infoMessage",

  "configureLoginServiceDialogVisible",
  "configureLoginServiceDialogServiceName",
  "configureLoginServiceDialogSaveDisabled",
  "configureOnDesktopVisible",
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

  configureService: function (name) {
    this.set("configureLoginServiceDialogVisible", true);
    this.set("configureLoginServiceDialogServiceName", name);
    this.set("configureLoginServiceDialogSaveDisabled", true);
  },
};
