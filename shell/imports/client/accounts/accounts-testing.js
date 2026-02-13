import { Meteor } from "meteor/meteor";

window.testFirstSignup = function () {
  Meteor.callAsync("testFirstSignup").catch((err) => {
    console.error("testFirstSignup failed:", err);
  });
};
