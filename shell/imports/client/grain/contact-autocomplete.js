import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { ReactiveVar } from "meteor/reactive-var";
import { Random } from "meteor/random";
import { _ } from "meteor/underscore";

import { ContactProfiles } from "/imports/client/contacts";

const generateAutoCompleteContacts = function (template) {
  let currentText = template.currentText.get();
  if (!currentText) {
    template.autoCompleteContacts.set([]);
    template.highlightedContact.set({ _id: null });
    return;
  }
  // TODO(someday): handle defaults for google/github/etc
  const defaults = [];
  if (currentText.indexOf("@") > 0) { // we also want to ignore starting with an @ symbol
    defaults.push({
      _id: "defaultEmail",
      intrinsicNames: [{ service: "email", name: "Email address" }],
      profile: {
        name: currentText,
        service: "email",
      },
      isDefault: true,
    });
  }

  currentText = currentText.toLowerCase();
  const selectedContactsIds = template.selectedContactsIds.get();
  const contacts = ContactProfiles.find({ _id: { $nin: selectedContactsIds } }).fetch();
  let results;
  if (currentText.lastIndexOf("@", 0) === 0) {
    const textWithoutAt = currentText.slice(1);
    results = _.filter(contacts, function (contact) {
      return contact.profile.handle.toLowerCase().indexOf(textWithoutAt) !== -1;
    });
  } else {
    results = _.filter(contacts, function (contact) {
      const intrinsicNames = contact.intrinsicNames;
      for (let i = 0; i < intrinsicNames.length; i++) {
        if (intrinsicNames[i].service.toLowerCase().indexOf(currentText) !== -1) return true;
        if (intrinsicNames[i].name.toLowerCase().indexOf(currentText) !== -1) return true;
      }

      return contact.profile.name.toLowerCase().indexOf(currentText) !== -1 ||
        contact.profile.handle.toLowerCase().indexOf(currentText) !== -1;
    });
  }

  template.autoCompleteContacts.set(defaults.concat(results));
  if (results.length > 0) {
    template.highlightedContact.set(results[0]);
  } else if (defaults.length > 0) {
    template.highlightedContact.set(defaults[0]);
  } else {
    template.highlightedContact.set({ _id: null });
  }
};

const selectContact = function (template, highlightedContact, inputBox) {
  if (highlightedContact.isDefault) {
    highlightedContact._id = inputBox.value;
    highlightedContact.profile.name = inputBox.value;
    highlightedContact.profile.pictureUrl = "/email.svg";
    highlightedContact.intrinsicNames = [{ service: "email", name: inputBox.value }];
  }

  const contacts = template.selectedContacts.get();
  contacts.push(highlightedContact);
  template.selectedContacts.set(contacts);

  const selectedContactsIds = template.selectedContactsIds.get();
  selectedContactsIds.push(highlightedContact._id);
  template.selectedContactsIds.set(selectedContactsIds);

  template.highlightedContact.set({ _id: null });
  inputBox.value = "";
  template.currentText.set(null);
};

const deleteSelected = function (contact, template) {
  const contacts = template.selectedContacts.get();
  template.selectedContacts.set(_.filter(contacts, function (selectedContact) {
    return selectedContact._id !== contact._id;
  }));

  const selectedContactsIds = template.selectedContactsIds.get();
  template.selectedContactsIds.set(_.filter(selectedContactsIds, function (selectedContactId) {
    return selectedContactId !== contact._id;
  }));

  template.find("input").focus();
};

Template.contactInputBox.onCreated(function () {
  this.currentText = new ReactiveVar(null);
  this.inputActive = new ReactiveVar(false);
  this.selectedContacts = this.data.contacts;
  this.selectedContactsIds = new ReactiveVar([]);
  this.highlightedContact = new ReactiveVar({ _id: null });
  this.subscribe("contactProfiles", false, {
    onReady: () => {
      if (this.data.preselectedIdentityId) {
        const contact = ContactProfiles.findOne({ _id: this.data.preselectedIdentityId });
        if (contact) {
          const contacts = this.selectedContacts.get();
          contacts.push(contact);
          this.selectedContacts.set(contacts);

          const ids = this.selectedContactsIds.get();
          ids.push(contact._id);
          this.selectedContactsIds.set(ids);
        }
      }
    },
  });

  this.randomId = Random.id();  // For use with aria requiring ids in html
  this.autoCompleteContacts = new ReactiveVar([]);
  this.autorun(generateAutoCompleteContacts.bind(this, this));
});

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
    const selectedContactId = Template.instance().highlightedContact.get()._id;
    return selectedContactId === this._id;
  },

  templateId: function () {
    return Template.instance().randomId;
  },
});

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
      const previous = event.target.previousElementSibling;
      if (previous) {
        previous.focus();
      }
    } else if (event.keyCode === 39 || event.keyCode === 40) { // Right or Down
      const next = event.target.nextElementSibling;
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
        const chip = template.find(".completed-contacts>li:last-child");
        if (chip) {
          chip.focus();
        }

        return false;
      }
    }
  },

  "keydown input": function (event, template) {
    if ((event.keyCode === 37 || event.keyCode === 38) && // Left or Up
        event.currentTarget.selectionStart === 0) { // Check that cursor is at beginning of input
      const chip = template.find(".completed-contacts>li:last-child");
      if (chip) {
        chip.focus();
      }

      return false;
    } else if (event.keyCode === 38) { // Up
      const contacts = template.autoCompleteContacts.get();
      if (contacts.length === 0) {
        return true;
      }

      const contactId = template.highlightedContact.get()._id;
      const ids = _.pluck(contacts, "_id");
      const index = ids.indexOf(contactId);
      let newContact = null;
      if (index >= 0) {
        if (index === 0) {
          newContact = contacts[contacts.length - 1];
        } else {
          newContact = contacts[index - 1];
        }
      } else if (contacts.length > 0) {
        newContact = contacts[0];
      }

      template.highlightedContact.set(newContact);
      Meteor.defer(function () {
        template.find("#" + template.randomId + "contact-selected").scrollIntoView(false);
      });

      return false;
    } else if (event.keyCode === 40) { // Down
      const contacts = template.autoCompleteContacts.get();
      if (contacts.length === 0) {
        return true;
      }

      const contactId = template.highlightedContact.get()._id;
      const ids = _.pluck(contacts, "_id");
      const index = ids.indexOf(contactId);
      let newContact = null;
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
      Meteor.defer(function () {
        template.find("#" + template.randomId + "contact-selected").scrollIntoView(false);
      });

      return false;
    } else if (event.keyCode === 13) { // Enter
      const highlightedContact = template.highlightedContact.get();
      if (highlightedContact._id) {
        selectContact(template, highlightedContact, event.target);
      }

      return false;
    }
  },

  "focus input": function (event, template) {
    template.inputActive.set(true);
  },

  "blur input": function (event, template) {
    template.inputActive.set(false);
  },

  "mousedown .autocomplete": function (event, template) {
    selectContact(template, this, template.find("input"));
    template.find("input").focus();

    return false;
  },
});
