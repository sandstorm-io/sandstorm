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

/* eslint-env mocha */

import Crypto from "crypto";
import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import { Mongo } from "meteor/mongo";
import chai from "chai";

import { SandstormDb } from "/imports/sandstorm-db/db";
// We import profile.js for the side-effect of defining more methods on SandstormDb.
// TODO(cleanup): Avoid adding methods to an object from another module like this; ew.
import {} from "/imports/sandstorm-db/profile";
import { SandstormPermissions } from "/imports/sandstorm-permissions/permissions";

const globalDb = new SandstormDb();
// Use local in-memory collections for permission-graph tests so synchronous graph traversal
// semantics remain deterministic under Meteor 3 server drivers.
globalDb.collections.grains = new Mongo.Collection(null);
globalDb.collections.apiTokens = new Mongo.Collection(null);
globalDb.collections.apiHosts = new Mongo.Collection(null);
globalDb.collections.users = new Mongo.Collection(null);
// TODO(cleanup): Use a lightweight fake (minimongo-based?) database here and construct a clean
// instance at the start of each test case.

const localizedTextPattern = {
  defaultText: String,
  localizations: Match.Optional([{ locale: String, text: String }]),
};

const roleDefPattern = {
  title: Match.Optional(localizedTextPattern),
  verbPhrase: Match.Optional(localizedTextPattern),
  description: Match.Optional(localizedTextPattern),
  permissions: [Boolean],
  obsolete: Match.Optional(Boolean),
  default: Match.Optional(Boolean),
};

const permissionDefPattern = {
  name: String,
  title: Match.Optional(localizedTextPattern),
  description: Match.Optional(localizedTextPattern),
  obsolete: Match.Optional(Boolean),
};

const viewInfoPattern = {
  permissions: Match.Optional([permissionDefPattern]),
  roles: Match.Optional([roleDefPattern]),
  deniedPermissions: Match.Optional([Boolean]),
  matchRequests: Match.Optional(Object), // TODO
  matchOffers: Match.Optional(Object),   // TODO
};

class Grain {
  constructor(id, viewInfo) {
    this.id = id;
    this.viewInfo = viewInfo;
  }

  static async create(db, account, viewInfo, isPublic) {
    check(db, SandstormDb);
    check(account, Account);
    check(viewInfo, viewInfoPattern);

    const id = Crypto.randomBytes(10).toString("hex");
    await db.collections.grains.insertAsync({
      _id: id,
      packageId: "mock-package-id",
      appId: "mock-app-id",
      appVersion: 0,
      userId: account.id,
      identityId: Crypto.randomBytes(10).toString("hex"),
      title: "mock-grain-title",
      cachedViewInfo: viewInfo,
      private: !isPublic,
    });

    return new Grain(id, viewInfo);
  }
}

class Account {
  constructor(db, id) {
    check(db, SandstormDb);
    this.db = db;
    this.id = id;
  }

  static async create(db, isAdmin) {
    check(db, SandstormDb);
    check(isAdmin, Boolean);

    const name = Crypto.randomBytes(10).toString("hex");
    const id = Crypto.randomBytes(10).toString("hex");
    await Meteor.users.insertAsync({
      _id: id,
      createdAt: new Date(),
      profile: { name: name },
      type: "account",
      loginCredentials: [],
      nonloginCredentials: [],
      isAdmin: isAdmin,
    });
    await db.collections.users.insertAsync({
      _id: id,
      createdAt: new Date(),
      profile: { name: name },
      type: "account",
      loginCredentials: [],
      nonloginCredentials: [],
      isAdmin: isAdmin,
    });
    return new Account(db, id);
  }

  mayOpenGrain(grain) {
    check(grain, Grain);
    return SandstormPermissions.mayOpenGrain(globalDb, { grain: { _id: grain.id,
                                                                  accountId: this.id, }, });
  }

  grainPermissions(grain) {
    check(grain, Grain);
    return SandstormPermissions.grainPermissions(globalDb,
                                                 { grain: { _id: grain.id,
                                                            accountId: this.id, }, },
                                                 grain.viewInfo).permissions;
  }

  async _shareTo(grainId, owner, roleAssignment, membraneRequirements) {
    return await createNewTokenHelper(this.db, grainId, { accountId: this.id },
                                      owner, roleAssignment, membraneRequirements);
  }

  async shareToAccount(grain, recipient, roleAssignment, membraneRequirements) {
    check(grain, Grain);
    check(recipient, Account);
    return await this._shareTo(grain.id, { user: { accountId: recipient.id, title: "share" } },
                               roleAssignment, membraneRequirements);
  }

  async shareToWebkey(grain, roleAssignment, membraneRequirements) {
    check(grain, Grain);
    const result = await this._shareTo(grain.id, { webkey: { forSharing: true } },
                                       roleAssignment, membraneRequirements);
    return new Webkey(this.db, result.token, result.id, grain);
  }
}

async function createNewTokenHelper(db, grainId, provider, owner, roleAssignment, membraneRequirements) {
  check(db, SandstormDb);
  check(grainId, String);
  check(roleAssignment, db.roleAssignmentPattern);
  const token = Crypto.randomBytes(20).toString("base64url");
  const id = Crypto.createHash("sha256").update(token).digest("base64");
  const apiToken = {
    _id: id,
    grainId: grainId,
    roleAssignment: roleAssignment,
    petname: "<petname>",
    created: new Date(),
    expires: null,
  };

  let parentForSharing = false;
  let parentApiToken;
  if (provider.rawParentToken) {
    const parentToken = Crypto.createHash("sha256").update(provider.rawParentToken).digest("base64");
    parentApiToken = await db.collections.apiTokens.findOneAsync(
        { _id: parentToken, grainId: grainId, objectId: { $exists: false } });
    if (!parentApiToken) {
      throw new Meteor.Error(403, "No such parent token found.");
    }

    parentForSharing = !!parentApiToken.forSharing;
    apiToken.accountId = parentApiToken.accountId;
    apiToken.parentToken = parentToken;
  } else if (provider.accountId) {
    apiToken.accountId = provider.accountId;
  }

  if (owner.webkey) {
    apiToken.owner = { webkey: null };
    apiToken.forSharing = parentForSharing || owner.webkey.forSharing;
  } else {
    apiToken.owner = owner;
  }

  if (membraneRequirements && membraneRequirements.length > 0) {
    apiToken.requirements = membraneRequirements;
  }

  await db.collections.apiTokens.insertAsync(apiToken);
  return { id: id, token: token, parentApiToken: parentApiToken };
}

class Webkey {
  constructor(db, rawToken, hashedToken, grain) {
    check(db, SandstormDb);
    check(rawToken, String);
    check(hashedToken, String);
    check(grain, Grain);
    this.db = db;
    this.rawToken = rawToken;
    this.hashedToken = hashedToken;
    this.grain = grain;
  }

  mayOpenGrain() {
    return SandstormPermissions.mayOpenGrain(globalDb, { token: { _id: this.hashedToken,
                                                                  grainId: this.grain.id, }, });
  }

  grainPermissions() {
    return SandstormPermissions.grainPermissions(globalDb,
                                                 { token: { _id: this.hashedToken,
                                                            grainId: this.grain.id, }, },
                                                 this.grain.viewInfo).permissions;
  }

  async _shareTo(owner, roleAssignment, membraneRequirements) {
    return await createNewTokenHelper(this.db, this.grain.id, { rawParentToken: this.rawToken }, owner,
                                      roleAssignment, membraneRequirements);
  }

  async shareToAccount(recipient, roleAssignment, membraneRequirements) {
    check(recipient, Account);
    return await this._shareTo({ user: { accountId: recipient.id, title: "share" } },
                               roleAssignment, membraneRequirements);
  }

  async shareToWebkey(roleAssignment, membraneRequirements) {
    const result = await this._shareTo({ webkey: { forSharing: true } },
                                       roleAssignment, membraneRequirements);
    return new Webkey(this.db, result.token, result.id, this.grain);
  }

}

const commonViewInfo = {
  permissions: [{ name: "one" }, { name: "two" }, { name: "three" }],
  roles: [{ permissions: [true, true, true] },  // 0
          { permissions: [true, false, false], default: true }, // 1
          { permissions: [false, false, true] },  // 2
          { permissions: [false, false, false] }, // 3
          { permissions: [true, true, false] },   // 4
          { permissions: [true, false, true] },   // 5
          { permissions: [false, true, true] },   // 6
         ],
};

// TODO(cleanup): The names of the tests below scan a bit poorly,
// because mocha expects you to write things like it("Should ...", ...),
// (which is why the function is called 'it'), but the names below are
// a holdover from when we were using Tinytest. We should reword.
describe("permissions", function() {
  it("legacy public grain", async function () {
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);
    const grain = await Grain.create(globalDb, alice, commonViewInfo, true);

    chai.assert.isOk(alice.mayOpenGrain(grain));
    chai.assert.isOk(bob.mayOpenGrain(grain));

    // anonymous
    chai.assert.isOk(
      SandstormPermissions.mayOpenGrain(globalDb, {
        grain: {
          _id: grain.id,
          accountId: null,
        },
      })
    );

    chai.assert.deepEqual(alice.grainPermissions(grain), [true, true, true]);
    chai.assert.deepEqual(bob.grainPermissions(grain), [true, false, false]);

    // anonymous
    chai.assert.deepEqual(
      SandstormPermissions.grainPermissions(
        globalDb,
        { grain: { _id: grain.id,
          accountId: null, }, },
        commonViewInfo
      ).permissions,
    [true, false, false]);
  });

  it("only owner may open private non-shared grain", async function () {
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);
    const carol = await Account.create(globalDb, false);
    const grain = await Grain.create(globalDb, alice, {});

    chai.assert.isOk(alice.mayOpenGrain(grain));
    chai.assert.isNotOk(bob.mayOpenGrain(grain));
    chai.assert.isNotOk(carol.mayOpenGrain(grain));
  });

  it("owner gets all permissions", async function () {
    const alice = await Account.create(globalDb, false);
    const grain = await Grain.create(globalDb, alice, commonViewInfo);

    chai.assert.deepEqual(alice.grainPermissions(grain), [true, true, true]);
  });

  it("default role", async function () {
    const alice = await Account.create(globalDb, false);
    const grain = await Grain.create(globalDb, alice, commonViewInfo);

    const webkey = await alice.shareToWebkey(grain, { none: null }, []);

    chai.assert.isOk(webkey.mayOpenGrain());
    chai.assert.deepEqual(webkey.grainPermissions(), [true, false, false]);
  });

  it("parentToken", async function () {
    const alice = await Account.create(globalDb, false);
    const grain = await Grain.create(globalDb, alice, commonViewInfo);

    const parent = await alice.shareToWebkey(grain, { allAccess: null });

    chai.assert.isOk(parent.mayOpenGrain());
    chai.assert.deepEqual(parent.grainPermissions(), [true, true, true]);

    const child = await parent.shareToWebkey({ roleId: 2 });

    chai.assert.isOk(child.mayOpenGrain());
    chai.assert.deepEqual(child.grainPermissions(), [false, false, true]);

    await globalDb.collections.apiTokens.updateAsync(parent.hashedToken, { $set: { revoked: true } });

    chai.assert.isNotOk(parent.mayOpenGrain());
    chai.assert.isNotOk(child.mayOpenGrain());
  });

  it("merge user permissions", async function () {
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);
    const grain = await Grain.create(globalDb, alice, commonViewInfo);

    const parent1 = await alice.shareToWebkey(grain, { allAccess: null });
    await parent1.shareToAccount(bob, { roleId: 1 });
    const parent2 = await alice.shareToWebkey(grain, { allAccess: null });
    await parent2.shareToAccount(bob, { roleId: 2 });

    chai.assert.isOk(bob.mayOpenGrain(grain));
    chai.assert.deepEqual(bob.grainPermissions(grain), [true, false, true]);
  });

  it("membrane requirements", async function () {
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);
    const carol = await Account.create(globalDb, false);
    const aliceGrain = await Grain.create(globalDb, alice, commonViewInfo);
    const bobGrain = await Grain.create(globalDb, bob, commonViewInfo);

    const requirement = {
      permissionsHeld: {
        grainId: bobGrain.id,
        accountId: carol.id,
        permissions: [true, false, false],
      },
    };

    const webkey = await alice.shareToWebkey(aliceGrain, { allAccess: null }, [requirement]);

    chai.assert.isNotOk(webkey.mayOpenGrain());

    const result = await bob.shareToAccount(bobGrain, carol, { roleId: 1 });

    chai.assert.isOk(carol.mayOpenGrain(bobGrain));
    chai.assert.isOk(webkey.mayOpenGrain());

    await globalDb.collections.apiTokens.updateAsync(result.id, { $set: { revoked: true } });

    chai.assert.isNotOk(webkey.mayOpenGrain());

    const requirement1 = {
      permissionsHeld: {
        grainId: bobGrain.id,
        accountId: alice.id,
        permissions: [true, false, false],
      },
    };

    await bob.shareToAccount(bobGrain, carol, { roleId: 1 }, [requirement1]);

    chai.assert.isNotOk(webkey.mayOpenGrain());
    await bob.shareToAccount(bobGrain, alice, { roleId: 1 });

    chai.assert.isOk(webkey.mayOpenGrain());
  });

  it("membrane requirements sequence", async function () {
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);
    const carol = await Account.create(globalDb, false);
    const aliceGrain = await Grain.create(globalDb, alice, commonViewInfo);
    const bobGrain = await Grain.create(globalDb, bob, commonViewInfo);

    const parentRequirement = {
      permissionsHeld: {
          grainId: bobGrain.id,
          accountId: carol.id,
          permissions: [true, false, false],
        },
    };

    const parent = await alice.shareToWebkey(aliceGrain, { allAccess: null }, [parentRequirement]);

    const childRequirement = {
      permissionsHeld: {
          grainId: bobGrain.id,
          accountId: carol.id,
          permissions: [true, false, true],
        },
    };

    const child = await parent.shareToWebkey({ allAccess: null }, [childRequirement]);

    chai.assert.isNotOk(child.mayOpenGrain());

    await bob.shareToAccount(bobGrain, carol, { roleId: 1 });

    chai.assert.isNotOk(child.mayOpenGrain());

    await bob.shareToAccount(bobGrain, carol, { roleId: 2 });

    chai.assert.isOk(child.mayOpenGrain());
  });

  it("membrane requirements loop", async function () {
    // Create two tokens with membrane requirements that depend on each other.
    // A naive permissions computation could get into a loop here.

    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);
    const aliceGrain = await Grain.create(globalDb, alice, commonViewInfo);
    const bobGrain = await Grain.create(globalDb, bob, commonViewInfo);

    const requirement1 = {
      permissionsHeld: {
        grainId: bobGrain.id,
        accountId: alice.id,
        permissions: [],
      },
    };

    await alice.shareToAccount(aliceGrain, bob, { allAccess: null }, [requirement1]);

    const requirement2 = {
      permissionsHeld: {
          grainId: aliceGrain.id,
          accountId: bob.id,
          permissions: [],
        },
    };

    await bob.shareToAccount(bobGrain, alice, { allAccess: null }, [requirement2]);

    chai.assert.isOk(alice.mayOpenGrain(aliceGrain));
    chai.assert.isNotOk(bob.mayOpenGrain(aliceGrain));
    chai.assert.isOk(bob.mayOpenGrain(bobGrain));
    chai.assert.isNotOk(alice.mayOpenGrain(bobGrain));

    chai.assert.deepEqual(alice.grainPermissions(bobGrain), null);
    chai.assert.deepEqual(bob.grainPermissions(aliceGrain), null);
  });

  it("membrane requirements nontrivial normalization", async function () {
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);
    const carol = await Account.create(globalDb, false);
    const aliceGrain = await Grain.create(globalDb, alice, commonViewInfo);

    const requirement1 = {
      permissionsHeld: {
        grainId: aliceGrain.id,
        accountId: carol.id,
        permissions: [true, true, true],
      },
    };

    const webkey = await alice.shareToWebkey(aliceGrain, { roleId: 2 }, [requirement1]);

    chai.assert.isNotOk(webkey.mayOpenGrain());

    const requirement2 = {
      permissionsHeld: {
          grainId: aliceGrain.id,
          accountId: bob.id,
          permissions: [true, true, false],
        },
    };

    await alice.shareToAccount(aliceGrain, carol, { roleId: 1 }, [requirement2]);
    chai.assert.isNotOk(webkey.mayOpenGrain());

    const requirement3 = {
      permissionsHeld: {
          grainId: aliceGrain.id,
          accountId: bob.id,
          permissions: [true, false, true],
        },
    };

    await alice.shareToAccount(aliceGrain, carol, { roleId: 2 }, [requirement3]);
    chai.assert.isNotOk(webkey.mayOpenGrain());

    const requirement4 = {
      permissionsHeld: {
          grainId: aliceGrain.id,
          accountId: bob.id,
          permissions: [true, true, true],
        },
    };

    await alice.shareToAccount(aliceGrain, carol, { roleId: 4 }, [requirement4]);
    chai.assert.isNotOk(webkey.mayOpenGrain());

    await alice.shareToAccount(aliceGrain, bob, { roleId: 1 });
    chai.assert.isNotOk(webkey.mayOpenGrain());

    await alice.shareToAccount(aliceGrain, bob, { roleId: 4 });
    chai.assert.isNotOk(webkey.mayOpenGrain());

    await alice.shareToAccount(aliceGrain, bob, { allAccess: null });
    chai.assert.isOk(webkey.mayOpenGrain());
  });

  it("many membrane requirements", async function () {
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);

    const grain = await Grain.create(globalDb, alice, commonViewInfo);
    const otherGrains = [];

    const NUM_OTHER_GRAINS = 30;

    for (let idx = 0; idx < NUM_OTHER_GRAINS; ++idx) {
      const otherGrain = await Grain.create(globalDb, alice, commonViewInfo);
      const requirement = {
        permissionsHeld: {
          grainId: otherGrain.id,
          accountId: bob.id,
          permissions: [],
        },
      };

      await alice.shareToAccount(grain, bob, { allAccess: null }, [requirement]);
      otherGrains.push(otherGrain);
    }

    chai.assert.isNotOk(bob.mayOpenGrain(grain));

    await alice.shareToAccount(otherGrains[0], bob, { allAccess: null });

    chai.assert.isOk(bob.mayOpenGrain(grain));
  });

  it("membrane requirements long chain", async function () {
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);

    const grains = [];

    const NUM_GRAINS = 50;

    for (let idx = 0; idx < NUM_GRAINS; ++idx) {
      grains.push(await Grain.create(globalDb, alice, commonViewInfo));
    }

    // Bob's access to grain[i] is dependent on his access to grain[i+1];
    for (let idx = 0; idx < NUM_GRAINS - 1; ++idx) {
      const requirement = {
        permissionsHeld: {
          grainId: grains[idx + 1].id,
          accountId: bob.id,
          permissions: [],
        },
      };
      await alice.shareToAccount(grains[idx], bob, { allAccess: null }, [requirement]);
    }

    chai.assert.isNotOk(bob.mayOpenGrain(grains[0]));

    await alice.shareToAccount(grains[grains.length - 1], bob, { allAccess: null });

    chai.assert.isOk(bob.mayOpenGrain(grains[0]));
    chai.assert.deepEqual(bob.grainPermissions(grains[0]), [true, true, true]);
  });

  function createViewInfo(numPermissions) {
    const permissionDefs = [];
    const roleDefs = [];

    for (let ii = 0; ii < numPermissions; ++ii) {
      permissionDefs.push({ name: ii.toString() });
      const roleDefPermissions = [];
      for (let jj = 0; jj < numPermissions; ++jj) {
        roleDefPermissions.push(ii !== jj);
      }

      const roleDef = { permissions: roleDefPermissions };
      if (ii == 0) {
        roleDef.default = true;
      }

      roleDefs.push(roleDef);
    }

    return { permissions: permissionDefs, roles: roleDefs };
  }

  it("membrane requirements many permissions", async function () {
    const NUM_PERMISSIONS = 25;
    const viewInfo = createViewInfo(NUM_PERMISSIONS);
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);

    const grain0 = await Grain.create(globalDb, alice, viewInfo);
    const grain1 = await Grain.create(globalDb, alice, viewInfo);

    const requirementPermissions = [];
    for (let idx = 0; idx < NUM_PERMISSIONS; ++idx) {
      requirementPermissions.push(idx % 2 == 0);
    }

    const requirement = {
      permissionsHeld: {
        grainId: grain1.id,
        accountId: bob.id,
        permissions: requirementPermissions,
      },
    };

    await alice.shareToAccount(grain0, bob, { allAccess: null }, [requirement]);
    chai.assert.isNotOk(bob.mayOpenGrain(grain0));
    for (let idx = 0; idx < NUM_PERMISSIONS; ++idx) {
      await alice.shareToAccount(grain1, bob, { roleId: idx });
    }

    chai.assert.isOk(bob.mayOpenGrain(grain0));
  });

  it("blow up disjunctive normal form", async function () {
    // In a previous version of our permissions computation, the time this test took to complete
    // was at least exponential in `NUM_PERMISSIONS`, and effectively took forever if
    // `NUM_PERMISSIONS` was greater than 10.

    const NUM_PERMISSIONS = 30;

    const viewInfo = createViewInfo(NUM_PERMISSIONS);
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);

    const grain1 = await Grain.create(globalDb, alice, viewInfo);
    const grain2 = await Grain.create(globalDb, alice, commonViewInfo);
    const allPermissions = new Array(NUM_PERMISSIONS);
    for (let idx = 0; idx < NUM_PERMISSIONS; ++idx) {
      allPermissions[idx] = true;
    }

    const requirement = {
      permissionsHeld: {
        grainId: grain1.id,
        accountId: bob.id,
        permissions: allPermissions,
      },
    };

    await alice.shareToAccount(grain2, bob, { allAccess: null }, [requirement]);

    chai.assert.isNotOk(bob.mayOpenGrain(grain1));
    chai.assert.isNotOk(bob.mayOpenGrain(grain2));

    const otherGrains = [];

    const NUM_OTHER_GRAINS = NUM_PERMISSIONS; // Also equals number of roles.

    for (let idx = 0; idx < NUM_OTHER_GRAINS; ++idx) {
      const otherGrain = await Grain.create(globalDb, alice, commonViewInfo);
      const requirement = {
        permissionsHeld: {
          grainId: otherGrain.id,
          accountId: bob.id,
          permissions: [],
        },
      };

      await alice.shareToAccount(grain1, bob, { roleId: idx }, [requirement]);
      otherGrains.push(otherGrain);
    }

    chai.assert.isNotOk(bob.mayOpenGrain(grain1));
    chai.assert.isNotOk(bob.mayOpenGrain(grain2));

    await alice.shareToAccount(otherGrains[0], bob, { allAccess: null });

    chai.assert.isOk(bob.mayOpenGrain(grain1));
    chai.assert.isNotOk(bob.mayOpenGrain(grain2));

    await alice.shareToAccount(otherGrains[otherGrains.length - 1], bob, { allAccess: null });

    chai.assert.isOk(bob.mayOpenGrain(grain1));
    chai.assert.isOk(bob.mayOpenGrain(grain2));
  });

  it("userIsAdmin requirements", async function () {
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);
    const carol = await Account.create(globalDb, false);
    const aliceGrain = await Grain.create(globalDb, alice, commonViewInfo);
    const bobGrain = await Grain.create(globalDb, bob, commonViewInfo);

    const requirement = { userIsAdmin: alice.id };
    const webkey = await alice.shareToWebkey(aliceGrain, { allAccess: null }, [requirement]);

    chai.assert.isNotOk(webkey.mayOpenGrain());
    chai.assert.isNotOk(!!webkey.grainPermissions());

    await Meteor.users.rawCollection().updateOne({ _id: alice.id }, { $set: { isAdmin: true } });
    await globalDb.collections.users.updateAsync({ _id: alice.id }, { $set: { isAdmin: true } });

    chai.assert.isOk(webkey.mayOpenGrain());
    chai.assert.deepEqual(webkey.grainPermissions(), [true, true, true]);

    const childWebkey = await webkey.shareToWebkey({ allAccess: null }, [{ userIsAdmin: bob.id }]);

    chai.assert.isNotOk(childWebkey.mayOpenGrain());
    chai.assert.isNotOk(!!childWebkey.grainPermissions());

    await Meteor.users.rawCollection().updateOne({ _id: bob.id }, { $set: { isAdmin: true } });
    await globalDb.collections.users.updateAsync({ _id: bob.id }, { $set: { isAdmin: true } });

    chai.assert.isOk(childWebkey.mayOpenGrain());
    chai.assert.deepEqual(childWebkey.grainPermissions(), [true, true, true]);
  });

  it("tokenValid requirements", async function () {
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);
    const aliceGrain = await Grain.create(globalDb, alice, commonViewInfo);
    const bobGrain = await Grain.create(globalDb, bob, commonViewInfo);

    const tokenId = Crypto.randomBytes(20).toString("base64");
    const requirement = { tokenValid: tokenId };

    const webkey = await alice.shareToWebkey(aliceGrain, { allAccess: null }, [requirement]);

    chai.assert.isNotOk(webkey.mayOpenGrain());
    chai.assert.isNotOk(!!webkey.grainPermissions());

    await globalDb.collections.apiTokens.insertAsync({ _id: tokenId });

    chai.assert.isOk(webkey.mayOpenGrain());
    chai.assert.deepEqual(webkey.grainPermissions(), [true, true, true]);

    const childTokenId = Crypto.randomBytes(20).toString("base64");

    await globalDb.collections.apiTokens.insertAsync({
      _id: childTokenId,
      parentToken: tokenId,
      requirements: [{
        permissionsHeld: {
          accountId: bob.id,
          grainId: aliceGrain.id,
          permissions: [],
        },
      },
      ],
    });

    const webkey2 = await alice.shareToWebkey(aliceGrain, { allAccess: null },
                                        [{ tokenValid: childTokenId }]);

    chai.assert.isNotOk(webkey2.mayOpenGrain());
    chai.assert.isNotOk(!!webkey2.grainPermissions());

    await alice.shareToAccount(aliceGrain, bob, { allAccess: null });

    chai.assert.isOk(webkey2.mayOpenGrain());
    chai.assert.deepEqual(webkey2.grainPermissions(), [true, true, true]);

    await globalDb.collections.apiTokens.removeAsync({ _id: tokenId });

    chai.assert.isNotOk(webkey2.mayOpenGrain());
    chai.assert.isNotOk(!!webkey2.grainPermissions());
  });

  it("collections app basic requirements", async function () {
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);
    const collectionGrain = await Grain.create(globalDb, alice, commonViewInfo);
    const otherGrain = await Grain.create(globalDb, alice, commonViewInfo);

    await alice.shareToAccount(collectionGrain, bob, { allAccess: null });

    chai.assert.isOk(bob.mayOpenGrain(collectionGrain));
    chai.assert.isNotOk(bob.mayOpenGrain(otherGrain));

    const webkey = await alice.shareToWebkey(otherGrain, { allAccess: null },
                                       [
                                         {
                                          permissionsHeld: {
                                            permissions: [],
                                            accountId: alice.id,
                                            grainId: collectionGrain.id,
                                          },
                                        },
                                       ]
                                      );

    chai.assert.isOk(bob.mayOpenGrain(collectionGrain));
    chai.assert.isNotOk(bob.mayOpenGrain(otherGrain));

    await webkey.shareToAccount(bob, { allAccess: null },
                           [
                             {
                              permissionsHeld: {
                                permissions: [],
                                accountId: bob.id,
                                grainId: collectionGrain.id,
                              },
                            },
                           ]
                          );

    chai.assert.isOk(bob.mayOpenGrain(collectionGrain));
    chai.assert.isOk(bob.mayOpenGrain(otherGrain));
  });

  it("permissionsHeld with tokenId", async function () {
    const alice = await Account.create(globalDb, false);
    const bob = await Account.create(globalDb, false);
    const grain = await Grain.create(globalDb, alice, commonViewInfo);

    const webkey = await alice.shareToWebkey(grain, { allAccess: null });

    chai.assert.isOk(webkey.mayOpenGrain(grain));

    await alice.shareToAccount(grain, bob, { allAccess: null },
                          [
                            {
                              permissionsHeld: {
                                permissions: [],
                                tokenId: webkey.hashedToken,
                                grainId: grain.id,
                              },
                            },
                          ]
                         );

    chai.assert.isOk(bob.mayOpenGrain(grain));

    await globalDb.collections.apiTokens.updateAsync(webkey.hashedToken, { $set: { revoked: true } });

    chai.assert.isNotOk(bob.mayOpenGrain(grain));
  });
});
