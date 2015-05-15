Package.describe({
  summary: "Send email messages. Forked from meteor/email.",
  version: "0.1.0"
});

Npm.depends({
  // Pinned at older version. 0.1.16+ uses mimelib, not mimelib-noiconv which is
  // much bigger. We need a better solution.
  mailcomposer: "0.1.15",
  simplesmtp: "0.3.10",
  "stream-buffers": "0.2.5"});

Package.onUse(function (api) {
  api.use('underscore', 'server');
  api.use('application-configuration');
  api.export('SandstormEmail', 'server');;
  api.addFiles('email.js', 'server');
});
