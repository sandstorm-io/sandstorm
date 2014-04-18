Npm.depends({
    'simplesmtp': '0.3.24',
    'mailparser': '0.4.2',
    "sendgrid": "1.0.1"
});

Package.on_use(function (api) {
    api.add_files('import.js', 'server');
});
