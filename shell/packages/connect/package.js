// Please keep this updated to match the version used by Meteor. Ugh.
Npm.depends({connect: '2.9.0'});

Package.onUse(function(api) {
  api.addFiles('import.js', 'server');
});
