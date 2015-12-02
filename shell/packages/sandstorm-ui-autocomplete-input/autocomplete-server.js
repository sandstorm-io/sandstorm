Meteor.publish("userContacts", function () {
  // TODO(someday): make this reactive
  var db = this.connection.sandstormDb;
  var self = this;
  var contacts = db.collections.contacts.find({ownerId: this.userId});
  var identityIds = _.pluck(contacts.fetch(), "identityId");
  var identities = Meteor.users.find({_id: {$in: identityIds}});

  identities.forEach(function (identity) {
    SandstormDb.fillInProfileDefaults(identity);
    SandstormDb.fillInIntrinsicName(identity);
    self.added("userContacts", identity._id,  _.pick(identity, ["_id", "profile"]));
  });

  this.ready();
});
