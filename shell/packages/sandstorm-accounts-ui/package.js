Package.describe({
  summary: "Sandstorm fork of accounts-ui",
  version: "0.1.0"
});

Package.onUse(function (api) {
  api.use(['tracker', 'service-configuration', 'accounts-base',
           'underscore', 'templating', 'session'], 'client');
  // Export Accounts (etc) to packages using this one.
  api.imply('accounts-base', ['client', 'server']);

  // Allow us to call Accounts.oauth.serviceNames, if there are any OAuth
  // services.
  api.use('sandstorm-accounts-oauth', {weak: true});

  api.use('less', 'client');
  api.use('reactive-dict', 'client');

  api.addFiles(['login_buttons.less'], 'client');

  api.addFiles([
    'login_buttons.html',
    'login_buttons_dialogs.html',

    'login_buttons_session.js',

    'login_buttons.js',
    'login_buttons_dialogs.js',

    'accounts_ui.js'], 'client');

  api.export("AccountsUi");
});
