Package.describe({
  summary: "Sandstorm fork of accounts-ui",
  version: "0.1.0"
});

Package.onUse(function (api) {
  api.use(['check', 'tracker', 'service-configuration', 'accounts-base',
           'underscore', 'templating', 'session', 'http', 'sandstorm-db'], 'client');
  api.use(['check', 'accounts-base', "accounts-identity"], 'server');

  // Export Accounts (etc) to packages using this one.
  api.imply('accounts-base', ['client', 'server']);

  api.use('sandstorm-accounts-packages', {weak: true});

  // Allow us to check if payments are enabled
  api.use('blackrock-payments', {weak: true});

  api.use('less', 'client');
  api.use('reactive-dict', 'client');

  api.addFiles([
    'login_buttons.html',
    'login_buttons.less',
    'login_buttons_dialogs.html',

    'login_buttons_session.js',

    'login_buttons.js',
    'login_buttons_dialogs.js',

    'account-settings.html',
    'account-settings.js',
    'accounts-ui-methods.js',

    'accounts_ui.js'], 'client');

  api.addFiles(["accounts-ui-server.js", "accounts-ui-methods.js"], "server");

  api.export("AccountsUi");
  api.export("SandstormAccountSettingsUi");
});
