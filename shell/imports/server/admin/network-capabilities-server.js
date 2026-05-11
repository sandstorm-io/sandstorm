import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";

Meteor.publish("adminGrains", async function (grainIds) {
  // If the caller is an admin, publishes the Grains referred to by the provided list of grain IDs.
  // Otherwise, does nothing.
  if (!await this.connection.sandstormDb.isAdminById(this.userId)) return [];
  check(grainIds, [String]);

  const db = this.connection.sandstormDb;
  return db.collections.grains.find({
    _id: {
      $in: grainIds,
    },
  }, {
    fields: {
      title: 1,
      packageId: 1,
    },
  });
});

Meteor.publish("adminPackages", async function (packageIds) {
  // If the caller is an admin, publishes the Packages referred to by the provided list of package
  // IDs.  Otherwise, does nothing.
  if (!await this.connection.sandstormDb.isAdminById(this.userId)) return [];
  check(packageIds, [String]);

  const db = this.connection.sandstormDb;
  return db.collections.packages.find({
    _id: {
      $in: packageIds,
    },
  }, {
    fields: {
      manifest: 1,
    },
  });
});

Meteor.publish("adminProfiles", async function (userIds) {
  // If the caller is an admin, publishes the Users listed by ID in userIds.
  // Otherwise, does nothing.
  if (!await this.connection.sandstormDb.isAdminById(this.userId)) return [];
  check(userIds, [String]);

  const db = this.connection.sandstormDb;
  return db.collections.users.find({
    _id: {
      $in: userIds,
    },
  }, { fields: { profile: 1 } });
});
