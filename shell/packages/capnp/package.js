Npm.depends({
    'capnp': '0.1.0'
});

Package.on_use(function (api) {
    api.add_files('import.js', 'server');
});
