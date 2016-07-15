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
  summary: "Sandstorm UI Powerbox",
  version: "0.1.0",
});

Package.onUse(function (api) {
  api.use(["ecmascript", "check", "reactive-var", "templating", "tracker", "underscore", "sandstorm-db", "sandstorm-ui-topbar", "mongo"], "client");
  api.use(["ecmascript", "check"], "server");
  api.addFiles(["powerbox.html", "powerbox-client.js"], "client");
  api.addFiles(["powerbox-server.js"], "server");
  api.export("SandstormPowerboxRequest", "client");
  api.export("SandstormPowerbox", "server");
});
