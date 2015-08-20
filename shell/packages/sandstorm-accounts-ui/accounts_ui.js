AccountsUi = function (db) {
  // Object implementing the accounts UI. Must be passed as the data context for the `loginButtons`
  // and `loginButtonsPopup` templates.

  this._services = new ReactiveDict();
  this._db = db;
}

AccountsUi.prototype.registerService = function (serviceName, displayName) {
  // Still register it as an oauth service
  // TODO(someday): don't do this?
  Accounts.oauth.registerService(serviceName);

  this._services.set(serviceName, displayName);
};

AccountsUi.prototype.deregisterService = function (serviceName) {
  // Still register it as an oauth service
  // TODO(someday): don't do this?
  Accounts.oauth.deregisterService(serviceName);

  this._services.set(serviceName, undefined);
};
