Npm.depends({
  simplesmtp: '0.3.35',
  mailparser: '0.4.2',
  mimelib: '0.2.14',
  mailcomposer: '0.2.11',
});

Package.onUse(function(api) {
  api.addFiles('import.js', 'server');
});
