Package.describe({
  summary: "An accounts package for an email + token login system",
  version: "0.1.0",
});

Package.onUse(function (api) {
  api.use(["ecmascript", "underscore", "random", "templating", "iron:router", "sandstorm-db", "sandstorm-email"]);
  api.use("accounts-base", ["client", "server"]);
  // Export Accounts (etc) to packages using this one.
  api.imply("accounts-base", ["client", "server"]);
  api.use("check");
  api.use("sha", ["server"]);
  api.use("email", ["server"]);
  api.use("reactive-var", ["client"]);

  api.addFiles(["token_client.js", "token_templates.html"], ["client"]);
  api.addFiles("token_server.js", ["server"]);
});

