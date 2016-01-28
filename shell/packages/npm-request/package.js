Package.describe({
  name: 'npm-request',
  version: '0.0.1',
  summary: 'A Meteor package so we can depend on request from npm',
  git: '',
});

Package.onUse(function(api) {
  api.versionsFrom('1.2.1');
  api.use('ecmascript');
  Npm.depends({
    "request": "2.67.0"
  });
});
