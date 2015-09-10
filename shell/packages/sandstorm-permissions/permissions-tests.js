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

var globalDb = new SandstormDb();

globalDb.collections.grains.remove({});

var aliceUserId = Accounts.insertUserDoc({ profile: {name: "Alice"}}, {});
var bobUserId = Accounts.insertUserDoc({ profile: {name: "Bob"}}, {});
var carolUserId = Accounts.insertUserDoc({ profile: {name: "Carol"}}, {});

var grain = { _id: "mock-grain-id", packageId: "mock-package-id", appId: "mock-app-id",
              appVersion: 0, userId: aliceUserId, title: "mock-grain-title", private: true };

globalDb.collections.grains.insert(grain);

var viewInfo = {
  permissions: [{name: "one"}, {name: "two"}, {name: "three"}],
  roles: [ {permissions: [true, true, true]},
           {permissions: [true, false, false], default: true},
           {permissions: [false, false, true]},
           {permissions: [false, false, false]}]
};

Tinytest.add('permissions: only owner may open private non-shared grain', function (test) {
  globalDb.collections.apiTokens.remove({});
  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, {grain: {_id: grain._id, userId: aliceUserId}}));
  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, {grain: {_id: grain._id, userId: bobUserId}}));
});

Tinytest.add('permissions: owner gets all permissions', function (test) {
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   {grain: {_id: grain._id, userId: aliceUserId}},
                                                   viewInfo),
             [true, true, true]);
});

Tinytest.add('permissions: default role', function (test) {
  var token = SandstormPermissions.createNewApiToken(globalDb,
                                                     grain.userId,
                                                     grain._id,
                                                     "test default permissions",
                                                     {none: null}, // default role
                                                     true);

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, {token: {_id: token.id, grainId: grain._id}}));

  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   {token: {_id: token.id, grainId: grain._id}},
                                                   viewInfo),
             [true, false, false]);
});

Tinytest.add('permissions: parentToken', function(test) {
  var token = SandstormPermissions.createNewApiToken(globalDb,
                                                 grain.userId,
                                                 grain._id,
                                                 "test parent permissions",
                                                 {allAccess: null},
                                                 true);

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, {token: {_id: token.id, grainId: grain._id}}));
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   {token: {_id: token.id, grainId: grain._id}},
                                                   viewInfo),
             [true, true, true]);

  var childToken = SandstormPermissions.createNewApiToken(globalDb,
                                                          grain.userId,
                                                          grain._id,
                                                          "test child permissions",
                                                          {roleId: 2},
                                                          true, null,
                                                          token.token);
  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, {token: {_id: childToken.id, grainId: grain._id}}));
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   {token: {_id: childToken.id, grainId: grain._id}},
                                                   viewInfo),
             [false, false, true]);

  globalDb.collections.apiTokens.update(token.id, {$set: {revoked: true}});
  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, {token: {_id: token.id, grainId: grain._id}}));
  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, {token: {_id: childToken.id, grainId: grain._id}}));
});

Tinytest.add('permissions: merge user permissions', function(test) {
  globalDb.collections.apiTokens.remove({});

  // TODO(soon): createNewApiToken() should allow the `owner` field to be set.

  var owner = {user: {userId: bobUserId, title: "bob's shared view"}};
  var newToken1 = {
    userId: aliceUserId,
    grainId: grain._id,
    roleAssignment: {roleId: 1},
    petname: "new token petname 1",
    created: new Date(),
    owner: owner,
  }
  var newToken2 = {
    userId: aliceUserId,
    grainId: grain._id,
    roleAssignment: {roleId: 2},
    petname: "new token petname 2",
    created: new Date(),
    owner: owner,
  }
  globalDb.collections.apiTokens.insert(newToken1);
  globalDb.collections.apiTokens.insert(newToken2);

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, {grain: {_id: grain._id, userId: bobUserId}}));
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   {grain: {_id: grain._id, userId: bobUserId}},
                                                   viewInfo),
             [true, false, true]);
});
