Npm.depends({
  bignum: '0.9.0',
});

Package.on_use(function(api) {
  api.addFiles('import.js', 'server');
});
