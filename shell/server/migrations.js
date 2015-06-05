// Minimal tooling for doing run-at-least-once, ordered migrations.
//
// Because migrations can experience partial failure and likely have
// side-effects, we should be careful to make sure all migrations are
// idempotent and safe to accidentally run multiple times.


// This must come after all the functions named within are defined.
// Only append to this list!  Do not modify or remove list entries;
// doing so is likely change the meaning and semantics of user databases.
var MIGRATIONS = [
];

migrateToLatest = function () {
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
