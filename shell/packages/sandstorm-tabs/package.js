Package.describe({
  name: 'sandstorm-tabs',
  summary: 'Sandstorm fork of templates:tabs.',
  version: '0.1.0',
});

Package.onUse(function(api) {
  api.versionsFrom('METEOR@1.0');
  api.use([
    'templating',
    'tracker',
    'check',
    'coffeescript'
  ], 'client');
  api.addFiles('templates:tabs.html', 'client');
  api.addFiles('templates:tabs.coffee', 'client');
  api.addFiles('templates:tabs.css', 'client');
});

Package.onTest(function(api) {
  api.use('tinytest');
  api.use('templates:tabs');
  api.addFiles('templates:tabs-tests.js');
});
