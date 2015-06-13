// Minimal tooling for doing run-at-least-once, ordered migrations.
//
// Because migrations can experience partial failure and likely have
// side-effects, we should be careful to make sure all migrations are
// idempotent and safe to accidentally run multiple times.

var updateLoginStyleToRedirect = function() {
  var configurations = Package["service-configuration"].ServiceConfiguration.configurations;
  ["google", "github"].forEach(function(serviceName) {
    var config = configurations.findOne({service: serviceName});
    if (config && config.loginStyle !== "redirect") {
      configurations.update({service: serviceName}, {$set: {loginStyle: "redirect"}});
    }
  });
};

var enableLegacyOAuthProvidersIfNotInSettings = function() {
  // In the before time, Google and Github login were enabled by default.
  //
  // This actually didn't make much sense, required the first user to configure
  // OAuth, and had some trust-the-first-user properties that weren't totally
  // secure.
  //
  // Now, we have admin-token, so we wish to disable all logins by default
  // (since they need to be configured anyway) but since users may have never
  // explicitly told Sandstorm that Google or Github login should be enabled,
  // we can't just use the value in the Settings collection, since it might
  // never have been set.
  //
  // Thus, if the service is configured but absent from Settings, we should
  // explicitly enable it in Settings, and then the rest of the logic can just
  // depend on what value is in Settings and default to false without breaking
  // user installations.
  var configurations = Package["service-configuration"].ServiceConfiguration.configurations;
  ["google", "github"].forEach(function(serviceName) {
    var config = configurations.findOne({service: serviceName});
    var serviceConfig = Settings.findOne({_id: serviceName});
    if (config && !serviceConfig) {
      // Only explicitly enable the login service if:
      // 1) the service is already configured
      // 2) there is no sandstorm configuration already present (the user was
      //    using the previous default behavior).
      Settings.insert({_id: serviceName, value: true});
    }
  });
};

// This must come after all the functions named within are defined.
// Only append to this list!  Do not modify or remove list entries;
// doing so is likely change the meaning and semantics of user databases.
var MIGRATIONS = [
  updateLoginStyleToRedirect,
  enableLegacyOAuthProvidersIfNotInSettings
];

function migrateToLatest() {
  var applied = Migrations.findOne({_id: "migrations_applied"});
  var start;
  if (!applied) {
    // Migrations table is not yet seeded with a value.  This means it has
    // applied 0 migrations.  Persist this.
    Migrations.insert({_id: "migrations_applied", value: 0});
    start = 0;
  } else {
    start = applied.value;
  }
  console.log("Migrations applied: " + start + "/" + MIGRATIONS.length);

  for (var i = start ; i < MIGRATIONS.length ; i++) {
    // Apply migration i, then record that migration i was successfully run.
    console.log("Applying migration " + i);
    MIGRATIONS[i]();
    Migrations.update({_id: "migrations_applied"}, {$set: {value: i+1}});
    console.log("Applied migration " + i);
  }
}

// Apply all migrations on startup.
Meteor.startup(migrateToLatest);
