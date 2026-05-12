import { Meteor } from 'meteor/meteor';
import { Template } from 'meteor/templating';
import { ReactiveVar } from 'meteor/reactive-var';

import './main.html';

const serverRuntime = new ReactiveVar("");

Meteor.call("getServerRuntime", (err, result) => {
  if (err) {
    console.error("getServerRuntime failed:", err);
    serverRuntime.set("ERROR");
  } else {
    serverRuntime.set(result);
  }
});

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
  serverRuntime() {
    return serverRuntime.get();
  },
});
