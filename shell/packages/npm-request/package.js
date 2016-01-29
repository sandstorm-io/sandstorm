Package.describe({
  summary: "Export the 'request' package from npm",
  version: "2.67.0",
  name: "npm-request"
});

Package.onUse(function(api) {
  api.export("Request", "server");
  api.addFiles("server.js", "server");
});

Npm.depends({
  'request': '2.67.0'
});
