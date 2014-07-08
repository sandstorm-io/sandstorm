Npm.depends({
    'capnp': '0.1.3'
});

Package.on_use(function (api) {
    api.add_files('import.js', 'server');
});
