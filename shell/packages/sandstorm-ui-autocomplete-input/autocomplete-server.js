Meteor.publish('userContacts', function() {
  var db = this.connection.sandstormDb;
  var self = this;

  // We maintain a map from identity IDs to live query handles that track profile changes.
  var contactIdentities = {};

  var self = this;
  function addIdentityOfContact(contact) {
    if (!(contact.identityId in contactIdentities)) {
      var user = Meteor.users.findOne({_id: contact.identityId});
      if (user) {
        SandstormDb.fillInProfileDefaults(user);
        SandstormDb.fillInIntrinsicName(user);
        var filteredUser = _.pick(user, '_id', 'profile');
        self.added('userContacts', user._id, filteredUser);
      }

      contactIdentities[contact.identityId] =
        Meteor.users.find({_id: contact.identityId}, {fields: {profile: 1}}).observeChanges({
          changed: function(id, fields) {
            self.changed('userContacts', id, fields);
          },
        });
    }
  }

  var cursor = db.collections.contacts.find({ownerId: this.userId});

  var handle = cursor.observe({
    added: function(contact) {
      addIdentityOfContact(contact);
    },

    changed: function(contact) {
      addIdentityOfContact(contact);
    },

    removed: function(contact) {
      self.removed('userContacts', contact.identityId);
      contactIdentities[contact.identityId].stop();
      delete contactIdentities[contact.identityId];
    },
  });
  this.ready();

  this.onStop(function() {
    handle.stop();
    Object.keys(contactIdentities).forEach(function(identityId) {
      contactIdentities[identityId].stop();
      delete contactIdentities[identityId];
    });
  });
});
