Npm.depends({
    'fs-extra': '0.9.1'
});

Package.on_use(function (api) {
    api.add_files('import.js', 'server');
});
