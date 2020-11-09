Package.describe({
  summary: "OpenID Connect (OIDC) flow for Meteor",
  version: "1.0.7",
  name: "accounts-oidc",
  git: "https://github.com/sandstorm-io/sandstorm.git",
});

Package.onUse(function(api) {
  api.versionsFrom('1.11.1');
  api.use('ecmascript');

  // api.use('oauth2@1.1.0', ['client', 'server']);
  api.use('oauth@1.1.0', ['client', 'server']);
  // api.use('http@1.1.0', 'server');
  api.use('underscore@1.0.0', ['server', 'client']);
  api.use('templating@1.1.0', 'client');
  // api.use('random@1.0.0', 'client');
  api.use('service-configuration@1.0.0', ['client', 'server']);
  api.use('accounts-base@1.2.0', ['client', 'server']);
  // api.use('accounts-oauth@1.1.0', ['client', 'server']);
  api.use('tmeasday:check-npm-versions@0.3.2', 'server');

  // api.addFiles(['oidc_configure.html', 'oidc_configure.js'], 'client');

  api.mainModule('oidc-server.js', 'server');
  api.mainModule('oidc-client.js', 'client');
});
