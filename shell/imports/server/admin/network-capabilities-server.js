import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { checkAuth } from "/imports/server/auth";

Meteor.publish("adminGrains", function (grainIds) {
  // If the caller is an admin, publishes the Grains referred to by the provided list of grain IDs.
  // Otherwise, does nothing.
  if (!isAdminById(this.userId)) return [];
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

Meteor.publish("adminPackages", function (packageIds) {
  // If the caller is an admin, publishes the Packages referred to by the provided list of package
  // IDs.  Otherwise, does nothing.
  if (!isAdminById(this.userId)) return [];
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

Meteor.publish("adminProfiles", function (userIds) {
  // If the caller is an admin, publishes the Users listed by ID in userIds.
  // Otherwise, does nothing.
  if (!isAdminById(this.userId)) return [];
  check(userIds, [String]);

  const db = this.connection.sandstormDb;
  return db.collections.users.find({
    _id: {
      $in: userIds,
    },
  }, { fields: { profile: 1 } });
});
