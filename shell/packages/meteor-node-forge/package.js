Npm.depends({
    'node-forge': '0.6.34'
});

Package.on_use(function (api) {
    api.add_files('import.js', 'server');
});
