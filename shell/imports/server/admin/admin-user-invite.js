import { Meteor } from "meteor/meteor";

Meteor.publish("allInviteTokens", function () {
  const db = this.connection.sandstormDb;
  if (!db.isAdminById(this.userId)) {
    throw new Meteor.Error(403, "User must be admin to list invite tokens.");
  }

  return db.collections.signupKeys.find({});
});
