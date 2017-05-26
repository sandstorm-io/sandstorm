import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { checkAuth } from "/imports/server/auth.js";

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
      identityId: 1,
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

Meteor.publish("adminIdentities", function (identityIds) {
  // If the caller is an admin, publishes the identity Users listed by ID in identityIds.
  // Otherwise, does nothing.
  if (!isAdminById(this.userId)) return [];
  check(identityIds, [String]);

  const db = this.connection.sandstormDb;
  return db.collections.users.find({
    _id: {
      $in: identityIds,
    },
  });
});
