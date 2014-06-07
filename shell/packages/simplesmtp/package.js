Npm.depends({
    'simplesmtp': '0.3.24',
    'mailparser': '0.4.2',
    'mimelib': '0.2.14',
    'mailcomposer': '0.2.11'
});

Package.on_use(function (api) {
    api.add_files('import.js', 'server');
});
