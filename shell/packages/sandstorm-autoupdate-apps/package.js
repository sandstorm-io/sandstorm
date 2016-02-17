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
  summary: "Sandstorm package for dealing with app updating.",
  version: "0.1.0",
});

Package.onUse(function (api) {
  api.use("ecmascript");
  api.use("http");
  api.addFiles(["autoupdate-apps.js"], ["server"]);
  api.export("SandstormAutoupdateApps");
});

Package.onTest(function (api) {
  api.use("ecmascript");
  api.use([
    "http", "practicalmeteor:sinon", "accounts-base", "sandstorm-db",
    "tinytest", "sandstorm-autoupdate-apps",
  ], ["server"]);
  api.addFiles("autoupdate-apps-tests.js", "server");
});
