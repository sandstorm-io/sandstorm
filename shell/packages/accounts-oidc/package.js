const { Package } = require("meteor/tools");

Package.describe({
  summary: "OpenID Connect (OIDC) flow for Meteor",
  version: "1.0.0",
  name: "accounts-oidc",
  git: "https://github.com/sandstorm-io/sandstorm.git",
});

Package.onUse(function(api) {
  api.versionsFrom("1.11.1");
  api.use("ecmascript");

  api.use("oauth@1.1.0", ["client", "server"]);
  api.use("service-configuration@1.0.0", ["client", "server"]);
  api.use("accounts-base@1.2.0", ["client", "server"]);
  api.use("tmeasday:check-npm-versions@0.3.2", "server");

  api.mainModule("oidc-server.js", "server");
  api.mainModule("oidc-client.js", "client");
});
