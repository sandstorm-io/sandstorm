import { Meteor } from "meteor/meteor";

export function isDevelopmentServer() {
  return !!(Meteor.settings && Meteor.settings.public && Meteor.settings.public.allowDevAccounts);
}
