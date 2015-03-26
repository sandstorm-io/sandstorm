Package.describe({
  summary: "Sandstorm package that provides hooks to activate many Account services",
  version: "0.1.0"
});

Package.onUse(function (api) {
  api.use(["underscore", "random"]);
  api.use("accounts-base", ["client", "server"]);
  // Export Accounts (etc) to packages using this one.
  api.imply("accounts-base", ["client", "server"]);
  api.use("sandstorm-accounts-oauth", ["client", "server"]);
  api.use("sandstorm-accounts-ui", {weak: true});
  api.use("google", ["client", "server"]);
  api.use("github", ["client", "server"]);

  api.addFiles("google_login_button.css", "client");
  api.addFiles("github_login_button.css", "client");

  api.addFiles("accounts.js", ["client", "server"]);
});

