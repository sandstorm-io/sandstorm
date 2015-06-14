Accounts.oauth = {};

var services = {};
var servicesDep = new Deps.Dependency;

// Helper for registering OAuth based accounts packages.
// On the server, adds an index to the user collection.
Accounts.oauth.registerService = function (name) {
  if (_.has(services, name))
    throw new Error("Duplicate service: " + name);
  services[name] = true;
  servicesDep.changed();

  if (Meteor.server) {
    // Accounts.updateOrCreateUserFromExternalService does a lookup by this id,
    // so this should be a unique index. You might want to add indexes for other
    // fields returned by your service (eg services.github.login) but you can do
    // that in your app.
    Meteor.users._ensureIndex('services.' + name + '.id',
                              {unique: 1, sparse: 1});
  }
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
  servicesDep.changed();
};

Accounts.oauth.serviceNames = function () {
  servicesDep.depend();
  return _.keys(services);
};
