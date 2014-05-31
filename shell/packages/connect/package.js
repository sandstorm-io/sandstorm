// Please keep this updated to match the version used by Meteor. Ugh.
Npm.depends({'connect': '2.9.0'});

Package.on_use(function (api) {
  api.add_files('import.js', 'server');
});
