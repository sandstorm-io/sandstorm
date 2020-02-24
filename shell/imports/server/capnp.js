// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2017 Sandstorm Development Group, Inc. and contributors
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

// Finds the capnp module by searching up the directory tree. We expect it to be located in a
// node_modules subdirectory of one of our parent directories.
//
// We used to use Npm.require() for this, but Meteor disabled the "search up the tree" behavior
// in: https://github.com/meteor/meteor/pull/9095

import fs from "fs";

const pathParts = process.cwd().split("/");

let Capnp;
for (;;) {
  const path = pathParts.join("/");

  if (fs.existsSync(`${path}/node_modules/capnp.node`)) {
    Capnp = Npm.require(`${path}/node_modules/capnp.js`);
    break;
  }

  if (pathParts.length === 0) {
    throw new Error(`Can't find capnp.node, starting from: ${process.cwd()}`);
  }

  pathParts.pop();
}

export default Capnp;
