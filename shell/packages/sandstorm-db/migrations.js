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

var denormalizeInviteInfo = function() {
  // When a user is invited via a signup token, the `signupKey` field of their user table entry
  // has always been populated to indicate the key they used. This points into the SignupKeys table
  // which has more information about the key, namely a freeform note entered by the admin when
  // they created the key. In the case that the email invite form was used, the note has the form
  // "E-mail invite to <address>".
  //
  // Later, we decided it was useful to indicate in the users table visible to the admin
  // information about the invite terms. Namely, for email invites we want to show the address
  // and for others we want to show the note. To make this efficient, fields `signupNote` and
  // `signupEmail` were added to the users table. We can backfill these values by denormalizing
  // from the SignupKeys table.

  Meteor.users.find().forEach(function (user) {
    if (user.signupKey && (typeof user.signupKey) === "string" && user.signupKey !== "admin") {
      var signupInfo = SignupKeys.findOne(user.signupKey);
      if (signupInfo && signupInfo.note) {
        var newFields = { signupNote: signupInfo.note };

        var prefix = "E-mail invite to ";
        if (signupInfo.note.lastIndexOf(prefix) === 0) {
          newFields.signupEmail = signupInfo.note.slice(prefix.length);
        }

        Meteor.users.update(user._id, {$set: newFields});
      }
    }
  });
}

function mergeRoleAssignmentsIntoApiTokens() {
  RoleAssignments.find().forEach(function(roleAssignment) {
    ApiTokens.insert({
      grainId: roleAssignment.grainId,
      userId: roleAssignment.sharer,
      roleAssignment: roleAssignment.roleAssignment,
      petname: roleAssignment.petname,
      created: roleAssignment.created,
      owner: {user: {userId: roleAssignment.recipient,
                     title: roleAssignment.title}},
    });
  });
}

function fixOasisStorageUsageStats() {
  // Before storage quota enforcement was first implemented, there were some bugs with the way the
  // Oasis backend tracked storage usage, which were not initially noticed since the resulting
  // number wasn't acutally used for anything.
  //
  // With the underlying bugs fixed, simply starting up each grain (supervisor only, not the app)
  // and then immediately shutting it down should cause the sizes to be recalculated correctly.
  //
  // This problem only applies to Oasis.

  if (Meteor.settings.public.quotaEnabled) {
    var dummyCommand = {
      argv: ["foo", "bar"],
      environ: []
    };

    Grains.find().forEach(function (grain) {
      try {
        console.log("refreshing grain:", grain._id);

        // We take a highly synchronous approach here so that the logging is understandable.
        var supervisor = waitPromise(sandstormBackend.startGrain(
            grain.userId, grain._id, grain.packageId, dummyCommand, false, false)).supervisor;
        try {
          waitPromise(supervisor.shutdown());
          throw new Error("shutdown() didn't disconnect!");
        } catch (err) {
          if (err.kjType !== "disconnected") throw err;
        }
      } catch (err) {
        console.log(err.stack);
      }
    });
  }
}

function fetchProfilePictures() {
  Meteor.users.find({}).forEach(function (user) {
    var url = userPictureUrl(user);
    if (url) {
      console.log("Fetching user picture:", url);
      var assetId = fetchPicture(url);
      if (assetId) {
        Meteor.users.update(user._id, {$set: {"profile.picture": assetId}});
      }
    }
  });
}

function assignPlans() {
  if (Meteor.settings.public.quotaEnabled && SandstormDb.paymentsMigrationHook) {
    SandstormDb.paymentsMigrationHook(SignupKeys, Plans.find().fetch());
  }
}

// This must come after all the functions named within are defined.
// Only append to this list!  Do not modify or remove list entries;
// doing so is likely change the meaning and semantics of user databases.
var MIGRATIONS = [
  updateLoginStyleToRedirect,
  enableLegacyOAuthProvidersIfNotInSettings,
  denormalizeInviteInfo,
  mergeRoleAssignmentsIntoApiTokens,
  fixOasisStorageUsageStats,
  fetchProfilePictures,
  assignPlans,
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
    console.log("Applying migration " + (i+1));
    MIGRATIONS[i]();
    Migrations.update({_id: "migrations_applied"}, {$set: {value: i+1}});
    console.log("Applied migration " + (i+1));
  }
}

// Apply all migrations on startup.
Meteor.startup(migrateToLatest);
