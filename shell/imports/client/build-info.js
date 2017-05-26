import { Meteor } from "meteor/meteor";

function getBuildInfo() {
  let build = Meteor.settings && Meteor.settings.public && Meteor.settings.public.build;
  const isNumber = typeof build === "number";
  if (!build) {
    build = "(unknown)";
  } else if (isNumber) {
    build = String(Math.floor(build / 1000)) + "." + String(build % 1000);
  }

  return {
    build: build,
    isUnofficial: !isNumber,
  };
}

export default getBuildInfo;
