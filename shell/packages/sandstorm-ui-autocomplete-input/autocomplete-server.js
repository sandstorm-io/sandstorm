Meteor.publish("userContacts", function () {
  var db = this.connection.sandstormDb;
  return db.collections.contacts.find({ownerId: this.userId});
});
