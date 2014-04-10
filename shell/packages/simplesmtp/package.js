Npm.depends({
    'simplesmtp': '0.3.24'
});

Package.on_use(function (api) {
    api.add_files('import.js', 'server');
});
