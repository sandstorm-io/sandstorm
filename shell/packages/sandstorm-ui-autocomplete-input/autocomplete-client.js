var UserContacts = new Mongo.Collection("userContacts");
// A psuedo-collection used to store the results of joining Contacts with identity profiles
//
// Each contains:
//   _id: the id of identity (from Meteor.users collection)
//   profile: the profile of the identity (see db.js for fields in this object) with profile
//     default values and `intrinsicName` added.

Template.contactInputBox.onCreated(function () {
  var self = this;
  this.currentText = new ReactiveVar(null);
  this.inputActive = new ReactiveVar(false);
  this.selectedContacts = this.data.contacts;
  this.selectedContactsIds = new ReactiveVar([]);
  this.highlightedContact = new ReactiveVar({_id: null});
  this.subscribe("userContacts");
  this.randomId = Random.id();  // For use with aria requiring ids in html
  this.autoCompleteContacts = new ReactiveVar([]);
  this.autorun(generateAutoCompleteContacts.bind(this, this));
});

function generateAutoCompleteContacts(template) {
  var currentText = template.currentText.get();
  if (!currentText) {
    template.autoCompleteContacts.set([]);
    template.highlightedContact.set({_id: null});
    return;
  }
  // TODO(someday): handle defaults for google/github/etc
  var defaults = [];
  if (currentText.indexOf("@") > 0) { // we also want to ignore starting with an @ symbol
    defaults.push({
      _id: "defaultEmail",
      profile: {
        name: currentText,
        service: "email",
        intrinsicName: "Email address"
      },
      isDefault: true,
    });
  }
  currentText = currentText.toLowerCase();
  var selectedContactsIds = template.selectedContactsIds.get();
  var contacts = UserContacts.find({_id: {$nin: selectedContactsIds}}).fetch();
  var results;
  if (currentText.lastIndexOf("@", 0) === 0) {
    var textWithoutAt = currentText.slice(1);
    results = _.filter(contacts, function (contact) {
      return contact.profile.handle.toLowerCase().indexOf(textWithoutAt) !== -1;
    });
  } else {
    results = _.filter(contacts, function (contact) {
      return contact.profile.name.toLowerCase().indexOf(currentText) !== -1 ||
        contact.profile.handle.toLowerCase().indexOf(currentText) !== -1 ||
        contact.profile.intrinsicName.toLowerCase().indexOf(currentText) !== -1;
    });
  }
  results.forEach(function (contact) {
    SandstormDb.fillInPictureUrl(contact);
  })
  template.autoCompleteContacts.set(defaults.concat(results));
  if (results.length > 0) {
    template.highlightedContact.set(results[0]);
  } else if (defaults.length > 0) {
    template.highlightedContact.set(defaults[0]);
  } else {
    template.highlightedContact.set({_id: null});
  }
};

Template.contactInputBox.helpers({
  completedContacts: function () {
    return Template.instance().selectedContacts.get();
  },
  autoCompleteContacts: function () {
    return Template.instance().autoCompleteContacts.get();
  },
  inputActive: function () {
    return Template.instance().inputActive.get();
  },
  isCurrentlySelected: function () {
    var selectedContactId = Template.instance().highlightedContact.get()._id;

    return selectedContactId === this._id;
  },
  templateId: function () {
    return Template.instance().randomId;
  }
});

function selectContact(template, highlightedContact, inputBox) {
  if (highlightedContact.isDefault) {
    if (highlightedContact.profile.service === "email") {
      highlightedContact._id = inputBox.value;
      highlightedContact.profile.name = inputBox.value;
      highlightedContact.profile.intrinsicName = inputBox.value;
      highlightedContact.profile.pictureUrl = "/email.svg";
    }
  }
  var contacts = template.selectedContacts.get();
  contacts.push(highlightedContact);
  template.selectedContacts.set(contacts);

  var selectedContactsIds = template.selectedContactsIds.get();
  selectedContactsIds.push(highlightedContact._id);
  template.selectedContactsIds.set(selectedContactsIds);

  template.highlightedContact.set({_id: null});
  inputBox.value = "";
  template.currentText.set(null);
}
function deleteSelected(contact, template) {
  var self = contact;
  var contacts = template.selectedContacts.get();
  template.selectedContacts.set(_.filter(contacts, function (contact) {
    return contact._id !== self._id;
  }));

  var selectedContactsIds = template.selectedContactsIds.get();
  template.selectedContactsIds.set(_.filter(selectedContactsIds, function (id) {
    return id !== self._id;
  }));
  template.find("input").focus();
}

Template.contactInputBox.events({
  "click .contact-box": function (event, template) {
    // Clicking anywhere inside the fake contact-box should focus the input
    template.find("input").focus();
  },
  "click .completed-contact": function (event, template) {
    // Prevent clicking on completed contacts from triggering the above focus
    return false;
  },
  "input input": function (event, template) {
    template.currentText.set(event.target.value);
  },
  "keydown .completed-contact": function (event, template) {
    if (event.keyCode === 8 || event.keyCode == 46) { // Backspace or Delete
      deleteSelected(this, template);
      return false;
    } else if (event.keyCode === 37 || event.keyCode === 38) { // Left or Up
      var previous = event.target.previousElementSibling;
      if (previous) {
        previous.focus();
      }
    } else if (event.keyCode === 39 || event.keyCode === 40) { // Right or Down
      var next = event.target.nextElementSibling;
      if (next) {
        next.focus();
      } else {
        template.find("input").focus();
      }
    }
  },
  "click .closer": function (event, template) {
    deleteSelected(this, template);
    return false;
  },
  "keyup input": function (event, template) {
    if (event.keyCode === 8) { // Backspace
      if (!event.target.value) {
        var chip = template.find(".completed-contacts>li:last-child");
        if (chip) {
          chip.focus();
        }
        return false;
      }
    }
  },
  "keydown input": function(event, template) {
    if (event.keyCode === 38) { // Up
      var contactId = template.highlightedContact.get()._id;
      var contacts = template.autoCompleteContacts.get();
      var ids = _.pluck(contacts, "_id");
      var index = ids.indexOf(contactId);
      var newContact = null;
      if (index >= 0) {
        if (index === 0) {
          newContact = contacts[contacts.length - 1];
        } else {
          newContact = contacts[index - 1];
        }
      } else if (contacts.length > 0) {
        newContact = contacts[0];
      }
      // TODO(someday): call scrollintoview on the now highlighted contact
      template.highlightedContact.set(newContact);
      return false;
    } else if (event.keyCode === 40) { // Down
      var contactId = template.highlightedContact.get()._id;
      var contacts = template.autoCompleteContacts.get();
      var ids = _.pluck(contacts, "_id");
      var index = ids.indexOf(contactId);
      var newContact = null;
      if (index >= 0) {
        if (index + 1 >= contacts.length) {
          newContact = contacts[0];
        } else {
          newContact = contacts[index + 1];
        }
      } else if (contacts.length > 0) {
        newContact = contacts[contacts.length - 1];
      }
      template.highlightedContact.set(newContact);
      return false;
    } else if (event.keyCode === 37) { // Left
      var chip = template.find(".completed-contacts>li:last-child");
      if (chip) {
        chip.focus();
      }
      return false;
    } else if (event.keyCode === 13) { // Enter
      var highlightedContact = template.highlightedContact.get();
      if (highlightedContact._id) {
        selectContact(template, highlightedContact, event.target);
      }
      return false;
    }
  },
  "focus input": function(event, template) {
    template.inputActive.set(true);
  },
  "blur input": function(event, template) {
    template.inputActive.set(false);
  },
  "mousedown .autocomplete, click .autocomplete": function(event, template) {
    selectContact(template, this, template.find("input"));
    template.find("input").focus();

    return false;
  },
});
