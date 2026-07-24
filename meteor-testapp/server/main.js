import { Meteor } from "meteor/meteor";

Meteor.methods({
  getServerRuntime() {
    return process.env.SERVER_RUNTIME;
  },
});
