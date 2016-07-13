Package.describe({
  summary: "Sandstorm package that provides hooks to activate many Account services",
  version: "0.1.0",
});

Package.onUse(function (api) {
  api.use("ecmascript");
  api.use(["underscore", "random"]);
  api.use("accounts-base", ["client", "server"]);
  // Export Accounts (etc) to packages using this one.
  api.imply("accounts-base", ["client", "server"]);
  api.use("accounts-oauth", ["client", "server"]);
  api.use("google", ["client", "server"]);
  api.use("github", ["client", "server"]);

  api.addFiles("accounts.js", ["client", "server"]);
});

