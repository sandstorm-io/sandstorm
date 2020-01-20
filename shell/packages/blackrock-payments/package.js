// Sandstorm Blackrock
// Copyright (c) 2015-2016 Sandstorm Development Group, Inc.
// All Rights Reserved
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

Package.describe({
  summary: "Blackrock payments integrations",
  version: "0.1.0"
});

Npm.depends({
    'stripe': '3.6.0',
});

Package.onUse(function (api) {
  api.use("ecmascript");
  api.use(["mongo", "sandstorm-db", "sandstorm-capnp"], "server");
  api.use(["mongo", "reactive-var", "templating"], "client");

  api.addFiles([
    "constants.js",
    "billingSettings.html",
    "billingPrompt.html",
    "billingSettings.js",
    "billingPrompt.js",
    "payments-client.js",
    "payments-api.html",
    "payments-api-client.js",
  ], "client");
  api.addFiles(["constants.js", "payments-server.js", "payments-api-server.js"], "server");
  api.addFiles(["checkout.html", "sandstorm-purplecircle.png"], "server", {isAsset: true});

  api.export(["BlackrockPayments", "makePaymentsConnectHandler"]);
});

// TODO(test): tests
