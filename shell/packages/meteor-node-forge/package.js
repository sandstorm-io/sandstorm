Npm.depends({
  "node-forge": "0.6.34",
});

Package.onUse(function (api) {
  api.addFiles("import.js", "server");
});
