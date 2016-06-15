Package.describe({
  name: "accounts-saml",
  summary: "saml login provider for meteor",
  version: "0.2.0",
  git: "https://github.com/nate-strauser/meteor-accounts-saml.git", // package was forked from here
});

Package.onUse(function (api) {
  api.use(["routepolicy", "webapp", "underscore", "service-configuration", "sandstorm-db"], "server");
  api.use(["http", "accounts-base", "random"], ["client", "server"]);

  api.addFiles(["saml_server.js", "saml_utils.js"], "server");
  api.addFiles("saml_client.js", "client");
  api.use("ecmascript");
});

Npm.depends({
  "xml2js": "0.2.0",
  "xml-crypto": "0.0.20",
  "xmldom": "0.1.6",
  "connect": "2.7.10",
  "xmlbuilder": "8.2.2",
});
