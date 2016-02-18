Package.describe({
  summary: "Export the ed25519 package from npm",
  version: "0.0.4",
  name: "npm-ed25519",
});

Package.onUse(function (api) {
  api.export("Ed25519", "server");
  api.addFiles("server.js", "server");
});

Npm.depends({
  ed25519: "0.0.4",
});
