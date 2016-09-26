const rootHost = Meteor.settings.public.rootUrl.split(":")[1].slice(2);
// Split on : to only capture the hostname (ie. ignore https?:). Do a slice(2) to strip out
// the leading //

const isStandalone = function () {
  return window.location.hostname !== rootHost;
};

export { isStandalone };
