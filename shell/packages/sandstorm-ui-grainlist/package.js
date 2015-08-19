// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
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
  summary: "Sandstorm UI grain list",
  version: "0.1.0"
});

Package.onUse(function (api) {
  api.use(["check", "reactive-var", "reload", "templating", "tracker", "sandstorm-db", "sandstorm-identicons", "underscore"], "client");
  // For the "userPackages" collection.  Perhaps that should move elsewhere.
  api.use(["sandstorm-ui-applist"], ["server"]);
  api.addFiles(["grainlist.html", "grainlist-client.js"], "client");
  api.addFiles(["grainlist-common.js"], ["client", "server"]);
  api.export("SandstormGrainList");
});

