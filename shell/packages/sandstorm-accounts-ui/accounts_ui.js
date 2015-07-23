/**
 * @summary Accounts UI
 * @namespace
 * @memberOf Accounts
 */
Accounts.ui = {};

Accounts.ui._options = {
  requestPermissions: {},
  requestOfflineToken: {},
  forceApprovalPrompt: {},
  services: {}
};

// XXX refactor duplicated code in this function

/**
 * @summary Register a service with the UI. These services are not dependent on OAuth facilities.
 * @locus Client
 * @param {String} serviceName
 * @param {String} userField Text to display for this service in the login dropdown box
 */
Accounts.ui.registerService = function (serviceName, userField) {
  // Still register it as an oauth service
  // TODO(someday): don't do this?
  Accounts.oauth.registerService(serviceName);

  Accounts.ui._options.services[serviceName] = userField;
};
Accounts.ui.deregisterService = function (serviceName, userField) {
  // Still register it as an oauth service
  // TODO(someday): don't do this?
  Accounts.oauth.deregisterService(serviceName);

  delete Accounts.ui._options.services[serviceName];
};
