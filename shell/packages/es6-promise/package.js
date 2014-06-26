Npm.depends({
    'es6-promise': '1.0.0'
});

Package.on_use(function (api) {
    api.add_files('promise.js', 'server');
});
