Npm.depends({
    'es6-promise': '0.1.1'
});

Package.on_use(function (api) {
    api.add_files('promise.js', 'server');
});
