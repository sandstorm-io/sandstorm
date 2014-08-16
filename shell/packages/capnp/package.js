Npm.depends({
    'es6-promise': '1.0.0',
    'capnp': '0.1.4'
});

Package.on_use(function (api) {
    api.add_files('import.js', 'server');
});
