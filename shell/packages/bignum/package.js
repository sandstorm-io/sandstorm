Npm.depends({
  bignum: '0.9.0',
});

Package.onUse(function(api) {
  api.addFiles('import.js', 'server');
});
