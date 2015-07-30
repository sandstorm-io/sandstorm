Package.describe({
  summary: "A package for setting up Meteor's Webapp Connect handlers for Sandstorm.",
  version: "0.1.0"
});

Package.onUse(function (api) {
  api.use(["connect", "webapp"], "server");
  api.addFiles('pre-meteor.js', 'server');
});
