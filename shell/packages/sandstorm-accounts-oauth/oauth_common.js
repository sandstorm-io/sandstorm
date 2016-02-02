Accounts.oauth = {};

var services = {};

// Helper for registering OAuth based accounts packages.
// On the server, adds an index to the user collection.
Accounts.oauth.registerService = function (name) {
  if (_.has(services, name))
    throw new Error("Duplicate service: " + name);
  services[name] = true;
};

// Removes a previously registered service.
// This will disable logging in with this service, and serviceNames() will not
// contain it.
// It's worth noting that already logged in users will remain logged in unless
// you manually expire their sessions.
Accounts.oauth.deregisterService = function (name) {
  if (!_.has(services, name))
    throw new Error("Service not found: " + name);
  delete services[name];
};

Accounts.oauth.serviceNames = function () {
  return _.keys(services);
};
