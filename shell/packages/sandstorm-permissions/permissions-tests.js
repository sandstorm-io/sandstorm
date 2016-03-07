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

const Crypto = Npm.require("crypto");

const globalDb = new SandstormDb();
// TODO(cleanup): Use a lightweight fake (minimongo-based?) database here and construct a clean
// instance at the start of each test case.

const viewInfo = {
  permissions: [{ name: "one" }, { name: "two" }, { name: "three" }],
  roles: [{ permissions: [true, true, true] },
          { permissions: [true, false, false], default: true },
          { permissions: [false, false, true] },
          { permissions: [false, false, false] },
         ],
};

function initializeDb() {
  globalDb.collections.grains.remove({});
  globalDb.collections.apiTokens.remove({});

  const aliceIdentityId = Accounts.insertUserDoc(
    { profile: { name: "Alice" }, },
    { services: { dev: { name: "alice" + Crypto.randomBytes(10).toString("hex"),
                         isAdmin: false, hasCompletedSignup: true, }, }, });
  const aliceAccountId = Accounts.insertUserDoc(
    {},
    { loginIdentities: [{ id: aliceIdentityId }], nonloginIdentities: [] });

  const bobIdentityId = Accounts.insertUserDoc(
    { profile: { name: "Bob" } },
    { services: { dev: { name: "Bob" + Crypto.randomBytes(10).toString("hex"),
                         isAdmin: false, hasCompletedSignup: true, }, }, });
  const bobAccountId = Accounts.insertUserDoc(
    {},
    { loginIdentities: [{ id: bobIdentityId }], nonloginIdentities: [] });

  const carolIdentityId = Accounts.insertUserDoc(
    { profile: { name: "Carol" } },
    { services: { dev:{ name: "Carol" + Crypto.randomBytes(10).toString("hex"),
                     isAdmin: false, hasCompletedSignup: true, }, }, });

  const grain0 = { _id: "mock-grain-id-0", packageId: "mock-package-id", appId: "mock-app-id",
                   appVersion: 0, userId: aliceAccountId,
                   identityId: carolIdentityId, // Shouldn't affect permissions computations.
                   title: "mock-grain-title", private: true,
                   cachedViewInfo: viewInfo, };

  const grain1 = { _id: "mock-grain-id-1", packageId: "mock-package-id", appId: "mock-app-id",
                   appVersion: 0, userId: bobAccountId,
                   identityId: carolIdentityId, // Shouldn't affect permissions computations.
                   title: "mock-grain-title", private: true,
                   cachedViewInfo: viewInfo, };

  const publicGrain = { _id: "mock-public-grain", packageId: "mock-package-id", appId: "mock-app-id",
                        appVersion: 0, userId: aliceAccountId,
                        identityId: carolIdentityId, // Shouldn't affect permissions computations.
                        title: "mock-grain-title",
                        cachedViewInfo: viewInfo, };

  globalDb.collections.grains.insert(grain0);
  globalDb.collections.grains.insert(grain1);
  globalDb.collections.grains.insert(publicGrain);

  return { grainIds: [grain0._id, grain1._id],
           publicGrainId: publicGrain._id,
           aliceUserId: aliceAccountId,
           aliceIdentityId: aliceIdentityId,
           bobUserId: bobAccountId,
           bobIdentityId: bobIdentityId,
           carolIdentityId: carolIdentityId, };
}

Tinytest.add("permissions: legacy public grain", function (test) {
  const data = initializeDb();
  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { grain: { _id: data.publicGrainId,
                                                           identityId: data.aliceIdentityId, }, }));
  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { grain: { _id: data.publicGrainId,
                                                           identityId: data.bobIdentityId, }, }));

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { grain: { _id: data.publicGrainId,
                                                           identityId: null, }, }));

  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   { grain: { _id: data.publicGrainId,
                                                              identityId: data.aliceIdentityId, }, },
                                                   viewInfo).permissions,
             [true, true, true]);

  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   { grain: { _id: data.publicGrainId,
                                                              identityId: data.bobIdentityId, }, },
                                                   viewInfo).permissions,
             [true, false, false]);

  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   { grain: { _id: data.publicGrainId,
                                                              identityId: null, }, },
                                                   viewInfo).permissions,
             [true, false, false]);

});

Tinytest.add("permissions: only owner may open private non-shared grain", function (test) {
  const data = initializeDb();
  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { grain: { _id: data.grainIds[0],
                                                         identityId: data.aliceIdentityId, }, }));
  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, { grain: { _id: data.grainIds[0],
                                                         identityId: data.bobIdentityId, }, }));
  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, { grain: { _id: data.grainIds[0],
                                                         identityId: data.carolIdentityId, }, }));

});

Tinytest.add("permissions: owner gets all permissions", function (test) {
  const data = initializeDb();
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   { grain: { _id: data.grainIds[0],
                                                            identityId: data.aliceIdentityId, }, },
                                                   viewInfo).permissions,
             [true, true, true]);
});

Tinytest.add("permissions: default role", function (test) {
  const data = initializeDb();
  const token = SandstormPermissions.createNewApiToken(globalDb,
                                                       { identityId: data.aliceIdentityId,
                                                         accountId: data.aliceUserId, },
                                                       data.grainIds[0],
                                                       "test default permissions",
                                                       { none: null }, // default role
                                                       { webkey: { forSharing: true } });

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { token: { _id: token.id, grainId: data.grainIds[0] } }));

  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   { token: { _id: token.id, grainId: data.grainIds[0] } },
                                                   viewInfo).permissions,
             [true, false, false]);
});

Tinytest.add("permissions: parentToken", function (test) {
  const data = initializeDb();
  const token = SandstormPermissions.createNewApiToken(globalDb,
                                                       { identityId: data.aliceIdentityId,
                                                         accountId: data.aliceUserId, },
                                                       data.grainIds[0],
                                                       "test parent permissions",
                                                       { allAccess: null },
                                                       { webkey: { forSharing: true } });

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { token: { _id: token.id, grainId: data.grainIds[0] } }));
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   { token: { _id: token.id, grainId: data.grainIds[0] } },
                                                   viewInfo).permissions,
             [true, true, true]);

  const childToken = SandstormPermissions.createNewApiToken(globalDb,
                                                          { rawParentToken: token.token },
                                                          data.grainIds[0],
                                                          "test child permissions",
                                                          { roleId: 2 },
                                                          { webkey: { forSharing: true } });

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { token: { _id: childToken.id,
                                                         grainId: data.grainIds[0], }, }));
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   { token: { _id: childToken.id,
                                                            grainId: data.grainIds[0], }, },
                                                   viewInfo).permissions,
             [false, false, true]);

  globalDb.collections.apiTokens.update(token.id, { $set: { revoked: true } });
  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, { token: { _id: token.id, grainId: data.grainIds[0] } }));
  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, { token: { _id: childToken.id,
                                                         grainId: data.grainIds[0], }, }));
});

Tinytest.add("permissions: merge user permissions", function (test) {
  const data = initializeDb();

  const owner = { user: { identityId: data.bobIdentityId, title: "bob's shared view" } };
  const parent1 = SandstormPermissions.createNewApiToken(globalDb,
                                                         { identityId: data.aliceIdentityId,
                                                           accountId: data.aliceUserId, },
                                                         data.grainIds[0],
                                                         "new token petname 1",
                                                         { allAccess: null },
                                                         { webkey: { forSharing: true } });

  SandstormPermissions.createNewApiToken(globalDb, { rawParentToken: parent1.token },
                                         data.grainIds[0],
                                         "new token petname 2", { roleId: 1 }, owner);

  const parent2 = SandstormPermissions.createNewApiToken(globalDb,
                                                         { identityId: data.aliceIdentityId,
                                                           accountId: data.aliceUserId, },
                                                         data.grainIds[0],
                                                         "new token petname 3",
                                                         { allAccess: null },
                                                         { webkey: { forSharing: true } });

  SandstormPermissions.createNewApiToken(globalDb, { rawParentToken: parent2.token },
                                         data.grainIds[0],
                                         "new token petname 4", { roleId: 2 }, owner);

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { grain: { _id: data.grainIds[0],
                                                         identityId: data.bobIdentityId, }, }));
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   { grain: { _id: data.grainIds[0],
                                                            identityId: data.bobIdentityId, }, },
                                                   viewInfo).permissions,
             [true, false, true]);
});

Tinytest.add("permissions: membrane requirements", function (test) {
  const data = initializeDb();

  const token = SandstormPermissions.createNewApiToken(globalDb,
                                                       { identityId: data.aliceIdentityId,
                                                         accountId: data.aliceUserId, },
                                                       data.grainIds[0],
                                                       "test membrane requirements",
                                                       { allAccess: null },
                                                       { webkey: { forSharing: true } });

  const requirement = {
    permissionsHeld: {
      grainId: data.grainIds[1],
      identityId: data.carolIdentityId,
      permissions: [true, false, false],
    },
  };

  globalDb.collections.apiTokens.update({ _id: token.id },
                                        { $push: { requirements: requirement } });

  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, { token: { _id: token.id,
                                                           grainId: data.grainIds[0], }, }));

  const token1 = SandstormPermissions.createNewApiToken(globalDb,
                                                       { identityId: data.bobIdentityId,
                                                         accountId: data.bobUserId, },
                                                       data.grainIds[1],
                                                       "test membrane requirements",
                                                       { roleId: 1 },
                                                       { user: {
                                                         identityId: data.carolIdentityId,
                                                         title: "direct share to Carol",
                                                       }, });
  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { grain: { _id: data.grainIds[1],
                                                           identityId: data.carolIdentityId, }, }));

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { token: { _id: token.id,
                                                           grainId: data.grainIds[0], }, }));
  globalDb.collections.apiTokens.update(
    { _id: token1.id },
    { $push: { requirements: {
      permissionsHeld: {
        grainId: data.grainIds[1],
        identityId: data.aliceIdentityId,
        permissions: [true, false, false],
      },
    }, }, });

  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, { token: { _id: token.id,
                                                           grainId: data.grainIds[0], }, }));

  SandstormPermissions.createNewApiToken(globalDb,
                                         { identityId: data.bobIdentityId,
                                           accountId: data.bobUserId, },
                                         data.grainIds[1],
                                         "test membrane requirements",
                                         { roleId: 1 },
                                         { user: {
                                           identityId: data.aliceIdentityId,
                                           title: "direct share to Carol",
                                         }, });

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { token: { _id: token.id,
                                                           grainId: data.grainIds[0], }, }));

});

Tinytest.add("permissions: membrane requirements sequence", function (test) {
  const data = initializeDb();

  const token = SandstormPermissions.createNewApiToken(globalDb,
                                                       { identityId: data.aliceIdentityId,
                                                         accountId: data.aliceUserId, },
                                                       data.grainIds[0],
                                                       "test membrane requirements sequence",
                                                       { allAccess: null },
                                                       { webkey: { forSharing: true } });

  globalDb.collections.apiTokens.update(
    { _id: token.id },
    { $push: { requirements: {
      permissionsHeld: {
        grainId: data.grainIds[1],
        identityId: data.carolIdentityId,
        permissions: [true, false, false],
      },
    }, }, });

  const childToken = SandstormPermissions.createNewApiToken(globalDb,
                                                            { rawParentToken: token.token },
                                                            data.grainIds[0],
                                                            "test membrane requirements sequence",
                                                            { allAccess: null },
                                                            { webkey: { forSharing: true } });

  globalDb.collections.apiTokens.update(
    { _id: childToken.id },
    { $push: { requirements: {
      permissionsHeld: {
        grainId: data.grainIds[1],
        identityId: data.carolIdentityId,
        permissions: [true, false, true],
      },
    }, }, });

  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, { token: { _id: childToken.id,
                                                           grainId: data.grainIds[0], }, }));

  SandstormPermissions.createNewApiToken(globalDb,
                                         { identityId: data.bobIdentityId,
                                           accountId: data.bobUserId, },
                                         data.grainIds[1],
                                         "test membrane requirements",
                                         { roleId: 1 },
                                         { user: {
                                           identityId: data.carolIdentityId,
                                           title: "direct share to Carol",
                                         }, });

  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, { token: { _id: childToken.id,
                                                           grainId: data.grainIds[0], }, }));

  SandstormPermissions.createNewApiToken(globalDb,
                                         { identityId: data.bobIdentityId,
                                           accountId: data.bobUserId, },
                                         data.grainIds[1],
                                         "test membrane requirements",
                                         { roleId: 2 },
                                         { user: {
                                           identityId: data.carolIdentityId,
                                           title: "direct share to Carol",
                                         }, });
  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { token: { _id: childToken.id,
                                                           grainId: data.grainIds[0], }, }));
});

Tinytest.add("permissions: membrane requirements loop", function (test) {

  // Create two tokens with membrane requirements that depend on each other.
  // A naive permissions computation could get into a loop here.

  const data = initializeDb();

  const token1 = SandstormPermissions.createNewApiToken(globalDb,
                                                        { identityId: data.aliceIdentityId,
                                                          accountId: data.aliceUserId, },
                                                        data.grainIds[0],
                                                        "test membrane requirements loop",
                                                        { allAccess: null },
                                                        { user: {
                                                          identityId: data.bobIdentityId,
                                                          title: "direct share to Bob",
                                                        }, });

  globalDb.collections.apiTokens.update(
    { _id: token1.id },
    { $push: { requirements: {
      permissionsHeld: {
        grainId: data.grainIds[1],
        identityId: data.aliceIdentityId,
        permissions: [],
      },
    }, }, });

  const token2 = SandstormPermissions.createNewApiToken(globalDb,
                                                        { identityId: data.bobIdentityId,
                                                          accountId: data.bobUserId, },
                                                        data.grainIds[1],
                                                        "test membrane requirements loop",
                                                        { allAccess: null },
                                                        { user: {
                                                          identityId: data.aliceIdentityId,
                                                          title: "direct share to Alice",
                                                        }, });

  globalDb.collections.apiTokens.update(
    { _id: token2.id },
    { $push: { requirements: {
      permissionsHeld: {
        grainId: data.grainIds[0],
        identityId: data.bobIdentityId,
        permissions: [],
      },
    }, }, });

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { grain: { _id: data.grainIds[0],
                                                           identityId: data.aliceIdentityId, }, }));
  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, { grain: { _id: data.grainIds[0],
                                                           identityId: data.bobIdentityId, }, }));

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, { grain: { _id: data.grainIds[1],
                                                           identityId: data.bobIdentityId, }, }));
  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, { grain: { _id: data.grainIds[1],
                                                           identityId: data.aliceIdentityId, }, }));

  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   { grain: { _id: data.grainIds[1],
                                                              identityId: data.aliceIdentityId, }, },
                                                   viewInfo).permissions,
             undefined);
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   { grain: { _id: data.grainIds[0],
                                                              identityId: data.bobIdentityId, }, },
                                                   viewInfo).permissions,
             undefined);
});
