Package.describe({
    name:"natestrauser:accounts-saml",
    summary: "saml login provider for meteor",
  version: "0.1.1",
  git: "https://github.com/nate-strauser/meteor-accounts-saml.git"
});

Package.on_use(function (api) {
  api.versionsFrom("METEOR@0.9.0");
    api.use(['routepolicy','webapp','underscore', 'service-configuration'], 'server');
    api.use(['http','accounts-base'], ['client', 'server']);

    api.add_files(['saml_server.js','saml_utils.js'], 'server');
	api.add_files('saml_client.js', 'client');
});

Npm.depends({
	"xml2js": "0.2.0",
    "xml-crypto": "0.0.20",
    "xmldom": "0.1.6",
  "connect": "2.7.10"
});


