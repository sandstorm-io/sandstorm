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
import { StaticAssetImpl, IdenticonStaticAssetImpl } from "/imports/server/static-asset.js";
const StaticAsset = Capnp.importSystem("sandstorm/util.capnp").StaticAsset;

class IdentityImpl extends PersistentImpl {
  constructor(db, saveTemplate, identityId) {
    super(db, saveTemplate);
    this.identityId = identityId;
    this.db = db;
  }

  getProfile() {
    const identity = this.db.getIdentity(this.identityId);

    const profile = {
      displayName: { defaultText: identity.profile.name },
      preferredHandle: identity.profile.handle,
      pronouns: identity.profile.pronoun,
    };

    if (identity.profile.picture) {
      profile.picture = new Capnp.Capability(new StaticAssetImpl(identity.profile.picture),
                                             StaticAsset);
    } else {
      const hash = this.identityId.slice(0, 32);
      profile.picture = new Capnp.Capability(new IdenticonStaticAssetImpl(hash, 24),
                                             StaticAsset);
    }

    return { profile: profile };
  }
};

// TODO(cleanup): Find a better home for this.
const MembraneRequirement = Match.OneOf(
  { tokenValid: String },
  { permissionsHeld:
    { identityId: String, grainId: String, permissions: Match.Optional([Boolean]), } },
  { permissionsHeld:
    { tokenId: String, grainId: String, permissions: Match.Optional([Boolean]), } },
  { userIsAdmin: String });


makeIdentity = (identityId, requirements) => {
  const saveTemplate = { frontendRef: { identity: identityId } };
  if (requirements) {
    check(requirements, [MembraneRequirement])
    saveTemplate.requirements = requirements;
  }

  return new Capnp.Capability(new IdentityImpl(globalDb, saveTemplate, identityId),
                              IdentityRpc.PersistentIdentity);
};

globalFrontendRefRegistry.register({
  frontendRefField: "identity",

  restore(db, saveTemplate, identityId) {
    return new Capnp.Capability(new IdentityImpl(db, saveTemplate, identityId),
                                IdentityRpc.PersistentIdentity);
  },
});
