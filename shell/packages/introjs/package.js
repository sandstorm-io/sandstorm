Package.describe({
  name: 'introjs',
  version: '2.0.0',
  summary: 'A copy of introjs, packaged as a Meteor package',
  git: '',
  documentation: 'README.md',
});

Package.onUse(function(api) {
  api.versionsFrom('1.2.1');
  api.use('ecmascript');
  api.addFiles('client/intro.js', 'client');
  api.addFiles('client/introjs.css', 'client');
});
