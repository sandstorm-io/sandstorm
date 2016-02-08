Package.describe({
  name: 'typ:accounts-ldap',
  version: '1.0.1',
  summary: 'Accounts login for LDAP using ldapjs. Supports anonymous DN search & LDAPS.',
  git: 'https://github.com/typ90/meteor-accounts-ldap',
  documentation: 'README.md'
});


Package.onUse(function(api) {
  api.versionsFrom('1.0.3.1');

  api.use(['templating'], 'client');
  api.use(['typ:ldapjs@0.7.3'], 'server');


  api.use('accounts-base', 'server');
  api.imply('accounts-base', 'accounts-password', ['client', 'server']);

  api.use('check');

  api.addFiles(['ldap_client.js'], 'client');
  api.addFiles(['ldap_server.js'], 'server');

  api.export('LDAP', 'server');
  api.export('LDAP_DEFAULTS', 'server');
});
