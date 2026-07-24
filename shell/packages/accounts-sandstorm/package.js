// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// Licensed under the MIT License. See LICENSE.

/* global Package */

Package.describe({
  name: "kenton:accounts-sandstorm",
  version: "0.8.0",
  summary: "Login service for Sandstorm applications, updated for Meteor 3",
  git: "https://github.com/sandstorm-io/meteor-accounts-sandstorm.git",
});

Package.onUse((api) => {
  api.versionsFrom("3.4.1");
  api.use(["ecmascript", "meteor", "random"], ["client", "server"]);
  api.use("accounts-base", ["client", "server"], { weak: true });
  api.use(["tracker", "reactive-var"], "client");
  api.use(["check", "ddp-server", "webapp"], "server");
  api.mainModule("client.js", "client");
  api.mainModule("server.js", "server");
  api.export("SandstormAccounts", "client");
});

Package.onTest((api) => {
  api.versionsFrom("3.4.1");
  api.use(["ecmascript", "meteortesting:mocha"]);
  api.mainModule("rendezvous.tests.js", "server");
});
