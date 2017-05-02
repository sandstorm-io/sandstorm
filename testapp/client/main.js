import { Template } from 'meteor/templating';
// import { ReactiveVar } from 'meteor/reactive-var';

import './main.html';

// Template.hello.onCreated(function helloOnCreated() {
//   // counter starts at 0
//   // this.counter = new ReactiveVar(0);
// });

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

// Template.hello.events({
//   'click button'(event, instance) {
//     // increment the counter when button is clicked
//     instance.counter.set(instance.counter.get() + 1);
//   },xz
// });
