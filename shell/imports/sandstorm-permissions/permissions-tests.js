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

// TODO(cleanup): These tests are no longer run in any automated fashion.
// Figure out a new strategy for making sure we run tests.

import Crypto from "crypto";

const globalDb = new SandstormDb();
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
  constructor(db, account, viewInfo, isPublic) {
    check(db, SandstormDb);
    check(account, Account);
    check(viewInfo, viewInfoPattern);
    this.viewInfo = viewInfo;
    this.id = Crypto.randomBytes(10).toString("hex");
    db.collections.grains.insert({
      _id: this.id,
      packageId: "mock-package-id",
      appId: "mock-app-id",
      appVersion: 0,
      userId: account.id,
      identityId: Crypto.randomBytes(10).toString("hex"),
      title: "mock-grain-title",
      cachedViewInfo: this.viewInfo,
      private: !isPublic,
    });

  }
}

class Account {
  constructor(db, isAdmin) {
    check(db, SandstormDb);
    check(isAdmin, Boolean);

    const name = Crypto.randomBytes(10).toString("hex");
    this.db = db;

    this.id = Accounts.insertUserDoc(
      { profile: { name: name }, },
      { type: "account", loginCredentials: [], nonloginCredentials: [], isAdmin: isAdmin, });
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

  _shareTo(grainId, owner, roleAssignment, membraneRequirements) {
    return createNewTokenHelper(this.db, grainId, { accountId: this.id },
                                owner, roleAssignment, membraneRequirements);
  }

  shareToAccount(grain, recipient, roleAssignment, membraneRequirements) {
    check(grain, Grain);
    check(recipient, Account);
    return this._shareTo(grain.id, { user: { accountId: recipient.id, title: "share" } },
                         roleAssignment, membraneRequirements);
  }

  shareToWebkey(grain, roleAssignment, membraneRequirements) {
    check(grain, Grain);
    const result = this._shareTo(grain.id, { webkey: { forSharing: true } },
                                 roleAssignment, membraneRequirements);
    return new Webkey(this.db, result.token, result.id, grain);
  }
}

function createNewTokenHelper(db, grainId, provider, owner, roleAssignment, membraneRequirements) {
  check(db, SandstormDb);
  check(grainId, String);
  check(roleAssignment, db.roleAssignmentPattern);
  const result = SandstormPermissions.createNewApiToken(db, provider, grainId, "<petname>",
                                                        roleAssignment, owner);
  if (membraneRequirements) {
    membraneRequirements.forEach((requirement) => {
      db.collections.apiTokens.update(
        { _id: result.id },
        { $push: { requirements: requirement } });
    });
  }

  return result;
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

  _shareTo(owner, roleAssignment, membraneRequirements) {
    return createNewTokenHelper(this.db, this.grain.id, { rawParentToken: this.rawToken }, owner,
                                roleAssignment, membraneRequirements);
  }

  shareToAccount(recipient, roleAssignment, membraneRequirements) {
    check(recipient, Account);
    return this._shareTo({ user: { accountId: recipient.id, title: "share" } },
                         roleAssignment, membraneRequirements);
  }

  shareToWebkey(roleAssignment, membraneRequirements) {
    const result = this._shareTo({ webkey: { forSharing: true } },
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

Tinytest.add("permissions: legacy public grain", function (test) {
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);
  const grain = new Grain(globalDb, alice, commonViewInfo, true);

  test.isTrue(alice.mayOpenGrain(grain));
  test.isTrue(bob.mayOpenGrain(grain));

  // anonymous
  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, {
      grain: {
        _id: grain.id,
        accountId: null,
      },
    })
  );

  test.equal(alice.grainPermissions(grain), [true, true, true]);
  test.equal(bob.grainPermissions(grain), [true, false, false]);

  // anonymous
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   { grain: { _id: grain.id,
                                                              accountId: null, }, },
                                                   commonViewInfo).permissions,
             [true, false, false]);
});

Tinytest.add("permissions: only owner may open private non-shared grain", function (test) {
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);
  const carol = new Account(globalDb, false);
  const grain = new Grain(globalDb, alice, {});

  test.isTrue(alice.mayOpenGrain(grain));
  test.isFalse(bob.mayOpenGrain(grain));
  test.isFalse(carol.mayOpenGrain(grain));
});

Tinytest.add("permissions: owner gets all permissions", function (test) {
  const alice = new Account(globalDb, false);
  const grain = new Grain(globalDb, alice, commonViewInfo);

  test.equal(alice.grainPermissions(grain), [true, true, true]);
});

Tinytest.add("permissions: default role", function (test) {
  const alice = new Account(globalDb, false);
  const grain = new Grain(globalDb, alice, commonViewInfo);

  const webkey = alice.shareToWebkey(grain, { none: null }, []);

  test.isTrue(webkey.mayOpenGrain());
  test.equal(webkey.grainPermissions(), [true, false, false]);
});

Tinytest.add("permissions: parentToken", function (test) {
  const alice = new Account(globalDb, false);
  const grain = new Grain(globalDb, alice, commonViewInfo);

  const parent = alice.shareToWebkey(grain, { allAccess: null });

  test.isTrue(parent.mayOpenGrain());
  test.equal(parent.grainPermissions(), [true, true, true]);

  const child = parent.shareToWebkey({ roleId: 2 });

  test.isTrue(child.mayOpenGrain());
  test.equal(child.grainPermissions(), [false, false, true]);

  globalDb.collections.apiTokens.update(parent.hashedToken, { $set: { revoked: true } });

  test.isFalse(parent.mayOpenGrain());
  test.isFalse(child.mayOpenGrain());
});

Tinytest.add("permissions: merge user permissions", function (test) {
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);
  const grain = new Grain(globalDb, alice, commonViewInfo);

  const parent1 = alice.shareToWebkey(grain, { allAccess: null });
  parent1.shareToAccount(bob, { roleId: 1 });
  const parent2 = alice.shareToWebkey(grain, { allAccess: null });
  parent2.shareToAccount(bob, { roleId: 2 });

  test.isTrue(bob.mayOpenGrain(grain));
  test.equal(bob.grainPermissions(grain), [true, false, true]);
});

Tinytest.add("permissions: membrane requirements", function (test) {
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);
  const carol = new Account(globalDb, false);
  const aliceGrain = new Grain(globalDb, alice, commonViewInfo);
  const bobGrain = new Grain(globalDb, bob, commonViewInfo);

  const requirement = {
    permissionsHeld: {
      grainId: bobGrain.id,
      accountId: carol.id,
      permissions: [true, false, false],
    },
  };

  const webkey = alice.shareToWebkey(aliceGrain, { allAccess: null }, [requirement]);

  test.isFalse(webkey.mayOpenGrain());

  const result = bob.shareToAccount(bobGrain, carol, { roleId: 1 });

  test.isTrue(carol.mayOpenGrain(bobGrain));
  test.isTrue(webkey.mayOpenGrain());

  globalDb.collections.apiTokens.update(result.id, { $set: { revoked: true } });

  test.isFalse(webkey.mayOpenGrain());

  const requirement1 = {
    permissionsHeld: {
      grainId: bobGrain.id,
      accountId: alice.id,
      permissions: [true, false, false],
    },
  };

  bob.shareToAccount(bobGrain, carol, { roleId: 1 }, [requirement1]);

  test.isFalse(webkey.mayOpenGrain());
  bob.shareToAccount(bobGrain, alice, { roleId: 1 });

  test.isTrue(webkey.mayOpenGrain());
});

Tinytest.add("permissions: membrane requirements sequence", function (test) {
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);
  const carol = new Account(globalDb, false);
  const aliceGrain = new Grain(globalDb, alice, commonViewInfo);
  const bobGrain = new Grain(globalDb, bob, commonViewInfo);

  const parentRequirement = {
    permissionsHeld: {
        grainId: bobGrain.id,
        accountId: carol.id,
        permissions: [true, false, false],
      },
  };

  const parent = alice.shareToWebkey(aliceGrain, { allAccess: null }, [parentRequirement]);

  const childRequirement = {
    permissionsHeld: {
        grainId: bobGrain.id,
        accountId: carol.id,
        permissions: [true, false, true],
      },
  };

  const child = parent.shareToWebkey({ allAccess: null }, [childRequirement]);

  test.isFalse(child.mayOpenGrain());

  bob.shareToAccount(bobGrain, carol, { roleId: 1 });

  test.isFalse(child.mayOpenGrain());

  bob.shareToAccount(bobGrain, carol, { roleId: 2 });

  test.isTrue(child.mayOpenGrain());
});

Tinytest.add("permissions: membrane requirements loop", function (test) {
  // Create two tokens with membrane requirements that depend on each other.
  // A naive permissions computation could get into a loop here.

  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);
  const aliceGrain = new Grain(globalDb, alice, commonViewInfo);
  const bobGrain = new Grain(globalDb, bob, commonViewInfo);

  const requirement1 = {
    permissionsHeld: {
      grainId: bobGrain.id,
      accountId: alice.id,
      permissions: [],
    },
  };

  alice.shareToAccount(aliceGrain, bob, { allAccess: null }, [requirement1]);

  const requirement2 = {
    permissionsHeld: {
        grainId: aliceGrain.id,
        accountId: bob.id,
        permissions: [],
      },
  };

  bob.shareToAccount(bobGrain, alice, { allAccess: null }, [requirement2]);

  test.isTrue(alice.mayOpenGrain(aliceGrain));
  test.isFalse(bob.mayOpenGrain(aliceGrain));
  test.isTrue(bob.mayOpenGrain(bobGrain));
  test.isFalse(alice.mayOpenGrain(bobGrain));

  test.equal(alice.grainPermissions(bobGrain), null);
  test.equal(bob.grainPermissions(aliceGrain), null);
});

Tinytest.add("permissions: membrane requirements nontrivial normalization", function (test) {
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);
  const carol = new Account(globalDb, false);
  const aliceGrain = new Grain(globalDb, alice, commonViewInfo);

  const requirement1 = {
    permissionsHeld: {
      grainId: aliceGrain.id,
      accountId: carol.id,
      permissions: [true, true, true],
    },
  };

  const webkey = alice.shareToWebkey(aliceGrain, { roleId: 2 }, [requirement1]);

  test.isFalse(webkey.mayOpenGrain());

  const requirement2 = {
    permissionsHeld: {
        grainId: aliceGrain.id,
        accountId: bob.id,
        permissions: [true, true, false],
      },
  };

  alice.shareToAccount(aliceGrain, carol, { roleId: 1 }, [requirement2]);
  test.isFalse(webkey.mayOpenGrain());

  const requirement3 = {
    permissionsHeld: {
        grainId: aliceGrain.id,
        accountId: bob.id,
        permissions: [true, false, true],
      },
  };

  alice.shareToAccount(aliceGrain, carol, { roleId: 2 }, [requirement3]);
  test.isFalse(webkey.mayOpenGrain());

  const requirement4 = {
    permissionsHeld: {
        grainId: aliceGrain.id,
        accountId: bob.id,
        permissions: [true, true, true],
      },
  };

  alice.shareToAccount(aliceGrain, carol, { roleId: 4 }, [requirement4]);
  test.isFalse(webkey.mayOpenGrain());

  alice.shareToAccount(aliceGrain, bob, { roleId: 1 });
  test.isFalse(webkey.mayOpenGrain());

  alice.shareToAccount(aliceGrain, bob, { roleId: 4 });
  test.isFalse(webkey.mayOpenGrain());

  alice.shareToAccount(aliceGrain, bob, { allAccess: null });
  test.isTrue(webkey.mayOpenGrain());
});

Tinytest.add("permissions: many membrane requirements", function (test) {
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);

  const grain = new Grain(globalDb, alice, commonViewInfo);
  const otherGrains = [];

  const NUM_OTHER_GRAINS = 30;

  for (let idx = 0; idx < NUM_OTHER_GRAINS; ++idx) {
    const otherGrain = new Grain(globalDb, alice, commonViewInfo);
    const requirement = {
      permissionsHeld: {
        grainId: otherGrain.id,
        accountId: bob.id,
        permissions: [],
      },
    };

    alice.shareToAccount(grain, bob, { allAccess: null }, [requirement]);
    otherGrains.push(otherGrain);
  }

  test.isFalse(bob.mayOpenGrain(grain));

  alice.shareToAccount(otherGrains[0], bob, { allAccess: null });

  test.isTrue(bob.mayOpenGrain(grain));
});

Tinytest.add("permissions: membrane requirements long chain", function (test) {
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);

  const grains = [];

  const NUM_GRAINS = 50;

  for (let idx = 0; idx < NUM_GRAINS; ++idx) {
    grains.push(new Grain(globalDb, alice, commonViewInfo));
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
    alice.shareToAccount(grains[idx], bob, { allAccess: null }, [requirement]);
  }

  test.isFalse(bob.mayOpenGrain(grains[0]));

  alice.shareToAccount(grains[grains.length - 1], bob, { allAccess: null });

  test.isTrue(bob.mayOpenGrain(grains[0]));
  test.equal(bob.grainPermissions(grains[0]), [true, true, true]);
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

Tinytest.add("permissions: membrane requirements many permissions", function (test) {
  const NUM_PERMISSIONS = 25;
  const viewInfo = createViewInfo(NUM_PERMISSIONS);
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);

  const grain0 = new Grain(globalDb, alice, viewInfo);
  const grain1 = new Grain(globalDb, alice, viewInfo);

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

  alice.shareToAccount(grain0, bob, { allAccess: null }, [requirement]);
  test.isFalse(bob.mayOpenGrain(grain0));
  for (let idx = 0; idx < NUM_PERMISSIONS; ++idx) {
    alice.shareToAccount(grain1, bob, { roleId: idx });
  }

  test.isTrue(bob.mayOpenGrain(grain0));
});

Tinytest.add("permissions: blow up disjunctive normal form", function (test) {
  // In a previous version of our permissions computation, the time this test took to complete
  // was at least exponential in `NUM_PERMISSIONS`, and effectively took forever if
  // `NUM_PERMISSIONS` was greater than 10.

  const NUM_PERMISSIONS = 30;

  const viewInfo = createViewInfo(NUM_PERMISSIONS);
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);

  const grain1 = new Grain(globalDb, alice, viewInfo);
  const grain2 = new Grain(globalDb, alice, commonViewInfo);
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

  alice.shareToAccount(grain2, bob, { allAccess: null }, [requirement]);

  test.isFalse(bob.mayOpenGrain(grain1));
  test.isFalse(bob.mayOpenGrain(grain2));

  const otherGrains = [];

  const NUM_OTHER_GRAINS = NUM_PERMISSIONS; // Also equals number of roles.

  for (let idx = 0; idx < NUM_OTHER_GRAINS; ++idx) {
    const otherGrain = new Grain(globalDb, alice, commonViewInfo);
    const requirement = {
      permissionsHeld: {
        grainId: otherGrain.id,
        accountId: bob.id,
        permissions: [],
      },
    };

    alice.shareToAccount(grain1, bob, { roleId: idx }, [requirement]);
    otherGrains.push(otherGrain);
  }

  test.isFalse(bob.mayOpenGrain(grain1));
  test.isFalse(bob.mayOpenGrain(grain2));

  alice.shareToAccount(otherGrains[0], bob, { allAccess: null });

  test.isTrue(bob.mayOpenGrain(grain1));
  test.isFalse(bob.mayOpenGrain(grain2));

  alice.shareToAccount(otherGrains[otherGrains.length - 1], bob, { allAccess: null });

  test.isTrue(bob.mayOpenGrain(grain1));
  test.isTrue(bob.mayOpenGrain(grain2));
});

Tinytest.add("permissions: userIsAdmin requirements", function (test) {
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);
  const carol = new Account(globalDb, false);
  const aliceGrain = new Grain(globalDb, alice, commonViewInfo);
  const bobGrain = new Grain(globalDb, bob, commonViewInfo);

  const requirement = { userIsAdmin: alice.id };
  const webkey = alice.shareToWebkey(aliceGrain, { allAccess: null }, [requirement]);

  test.isFalse(webkey.mayOpenGrain());
  test.isFalse(!!webkey.grainPermissions());

  Meteor.users.update({ _id: alice.id }, { $set: { isAdmin: true } });

  test.isTrue(webkey.mayOpenGrain());
  test.equal(webkey.grainPermissions(), [true, true, true]);

  const childWebkey = webkey.shareToWebkey({ allAccess: null }, [{ userIsAdmin: bob.id }]);

  test.isFalse(childWebkey.mayOpenGrain());
  test.isFalse(!!childWebkey.grainPermissions());

  Meteor.users.update({ _id: bob.id }, { $set: { isAdmin: true } });

  test.isTrue(childWebkey.mayOpenGrain());
  test.equal(childWebkey.grainPermissions(), [true, true, true]);
});

Tinytest.add("permissions: tokenValid requirements", function (test) {
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);
  const aliceGrain = new Grain(globalDb, alice, commonViewInfo);
  const bobGrain = new Grain(globalDb, bob, commonViewInfo);

  const tokenId = Crypto.randomBytes(20).toString("base64");
  const requirement = { tokenValid: tokenId };

  const webkey = alice.shareToWebkey(aliceGrain, { allAccess: null }, [requirement]);

  test.isFalse(webkey.mayOpenGrain());
  test.isFalse(!!webkey.grainPermissions());

  globalDb.collections.apiTokens.insert({ _id: tokenId });

  test.isTrue(webkey.mayOpenGrain());
  test.equal(webkey.grainPermissions(), [true, true, true]);

  const childTokenId = Crypto.randomBytes(20).toString("base64");

  globalDb.collections.apiTokens.insert({
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

  const webkey2 = alice.shareToWebkey(aliceGrain, { allAccess: null },
                                      [{ tokenValid: childTokenId }]);

  test.isFalse(webkey2.mayOpenGrain());
  test.isFalse(!!webkey2.grainPermissions());

  alice.shareToAccount(aliceGrain, bob, { allAccess: null });

  test.isTrue(webkey2.mayOpenGrain());
  test.equal(webkey2.grainPermissions(), [true, true, true]);

  globalDb.collections.apiTokens.remove({ _id: tokenId });

  test.isFalse(webkey2.mayOpenGrain());
  test.isFalse(!!webkey2.grainPermissions());
});

Tinytest.add("permissions: collections app basic requirements", function (test) {
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);
  const collectionGrain = new Grain(globalDb, alice, commonViewInfo);
  const otherGrain = new Grain(globalDb, alice, commonViewInfo);

  alice.shareToAccount(collectionGrain, bob, { allAccess: null });

  test.isTrue(bob.mayOpenGrain(collectionGrain));
  test.isFalse(bob.mayOpenGrain(otherGrain));

  const webkey = alice.shareToWebkey(otherGrain, { allAccess: null },
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

  test.isTrue(bob.mayOpenGrain(collectionGrain));
  test.isFalse(bob.mayOpenGrain(otherGrain));

  webkey.shareToAccount(bob, { allAccess: null },
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

  test.isTrue(bob.mayOpenGrain(collectionGrain));
  test.isTrue(bob.mayOpenGrain(otherGrain));
});

Tinytest.add("permissions: permissionsHeld with tokenId", function (test) {
  const alice = new Account(globalDb, false);
  const bob = new Account(globalDb, false);
  const grain = new Grain(globalDb, alice, commonViewInfo);

  const webkey = alice.shareToWebkey(grain, { allAccess: null });

  test.isTrue(webkey.mayOpenGrain(grain));

  alice.shareToAccount(grain, bob, { allAccess: null },
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

  test.isTrue(bob.mayOpenGrain(grain));

  globalDb.collections.apiTokens.update(webkey.hashedToken, { $set: { revoked: true } });

  test.isFalse(bob.mayOpenGrain(grain));
});
