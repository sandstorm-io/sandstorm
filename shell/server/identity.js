// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

const Capnp = Npm.require("capnp");
const IdentityRpc = Capnp.importSystem("sandstorm/identity-impl.capnp");
import { PersistentImpl } from "/imports/server/persistent.js";

class IdentityImpl extends PersistentImpl {
  constructor(db, saveTemplate, identityId) {
    super(db, saveTemplate);
    this.identityId = identityId;
  }
};

makeIdentity = (identityId, requriements) => {
  const saveTemplate = { frontendRef: { identity: identityId } };
  return new Capnp.Capability(new IdentityImpl(globalDb, saveTemplate, identityId),
                              IdentityRpc.PersistentIdentity);
};

globalFrontendRefRegistry.addRestoreHandler("identity",
    (db, saveTemplate, identityId) => {
  return new Capnp.Capability(new IdentityImpl(db, saveTemplate, identityId),
                              IdentityRpc.PersistentIdentity);
});
