import { Template } from 'meteor/templating';

import './main.html';

Template.hello.helpers({
  id() {
    return Meteor.sandstormUser().id;
  },
  name() {
    return Meteor.sandstormUser().name;
  },
  picture() {
    return Meteor.sandstormUser().picture;
  },
  preferredHandle() {
    return Meteor.sandstormUser().preferredHandle;
  },
  pronouns() {
    return Meteor.sandstormUser().pronouns;
  },
});
