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

// Until David is done working on this:
// jscs:disable

var Crypto = Npm.require("crypto");

var globalDb = new SandstormDb();
// TODO(cleanup): Use a lightweight fake (minimongo-based?) database here and construct a clean
// instance at the start of each test case.

function initializeDb() {
  globalDb.collections.grains.remove({});
  globalDb.collections.apiTokens.remove({});

  var aliceIdentityId = Accounts.insertUserDoc(
    {profile: {name: "Alice"}},
    {services: {dev: {name: "alice" + Crypto.randomBytes(10).toString("hex"),
                      isAdmin: false, hasCompletedSignup: true}}});
  var aliceAccountId = Accounts.insertUserDoc({},
    {loginIdentities: [{id: aliceIdentityId}], nonloginIdentities: []});
  var bobIdentityId = Accounts.insertUserDoc(
    {profile: {name: "Bob"}},
    {services: {dev: {name: "Bob" + Crypto.randomBytes(10).toString("hex"),
                      isAdmin: false, hasCompletedSignup: true}}});
  var carolIdentityId = Accounts.insertUserDoc(
    {profile: {name: "Carol"}},
    {services: {dev:{name: "Carol" + Crypto.randomBytes(10).toString("hex"),
                     isAdmin: false, hasCompletedSignup: true}}});

  var grain = { _id: "mock-grain-id", packageId: "mock-package-id", appId: "mock-app-id",
                appVersion: 0, userId: aliceAccountId,
                identityId: carolIdentityId, // Shouldn't affect permissions computations.
                title: "mock-grain-title", private: true };

  globalDb.collections.grains.insert(grain);
  return {grainId: grain._id,
          aliceUserId: aliceAccountId,
          aliceIdentityId: aliceIdentityId,
          bobIdentityId: bobIdentityId,
          carolIdentityId: carolIdentityId};
}

var viewInfo = {
  permissions: [{name: "one"}, {name: "two"}, {name: "three"}],
  roles: [ {permissions: [true, true, true]},
           {permissions: [true, false, false], default: true},
           {permissions: [false, false, true]},
           {permissions: [false, false, false]}]
};

Tinytest.add('permissions: only owner may open private non-shared grain', function (test) {
  var data = initializeDb();
  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, {grain: {_id: data.grainId,
                                                         identityId: data.aliceIdentityId}}));
  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, {grain: {_id: data.grainId,
                                                         identityId: data.bobIdentityId}}));

  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, {grain: {_id: data.grainId,
                                                         identityId: data.carolIdentityId}}));

});

Tinytest.add('permissions: owner gets all permissions', function (test) {
  var data = initializeDb();
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   {grain: {_id: data.grainId,
                                                            identityId: data.aliceIdentityId}},
                                                   viewInfo),
             [true, true, true]);
});


Tinytest.add('permissions: default role', function (test) {
  var data = initializeDb();
  var token = SandstormPermissions.createNewApiToken(globalDb,
                                                     {identityId: data.aliceIdentityId,
                                                      accountId: data.aliceUserId},
                                                     data.grainId,
                                                     "test default permissions",
                                                     {none: null}, // default role
                                                     {webkey: {forSharing: true}});

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, {token: {_id: token.id, grainId: data.grainId}}));

  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   {token: {_id: token.id, grainId: data.grainId}},
                                                   viewInfo),
             [true, false, false]);
});


Tinytest.add('permissions: parentToken', function(test) {
  var data = initializeDb();
  var token = SandstormPermissions.createNewApiToken(globalDb,
                                                     {identityId: data.aliceIdentityId,
                                                      accountId: data.aliceUserId},
                                                 data.grainId,
                                                 "test parent permissions",
                                                 {allAccess: null},
                                                 {webkey: {forSharing: true}});

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, {token: {_id: token.id, grainId: data.grainId}}));
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   {token: {_id: token.id, grainId: data.grainId}},
                                                   viewInfo),
             [true, true, true]);

  var childToken = SandstormPermissions.createNewApiToken(globalDb,
                                                          {rawParentToken: token.token},
                                                          data.grainId,
                                                          "test child permissions",
                                                          {roleId: 2},
                                                          {webkey: {forSharing: true}});

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, {token: {_id: childToken.id,
                                                         grainId: data.grainId}}));
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   {token: {_id: childToken.id,
                                                            grainId: data.grainId}},
                                                   viewInfo),
             [false, false, true]);

  globalDb.collections.apiTokens.update(token.id, {$set: {revoked: true}});
  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, {token: {_id: token.id, grainId: data.grainId}}));
  test.isFalse(
    SandstormPermissions.mayOpenGrain(globalDb, {token: {_id: childToken.id,
                                                         grainId: data.grainId}}));
});

Tinytest.add('permissions: merge user permissions', function(test) {
  var data = initializeDb();

  var owner = {user: {identityId: data.bobIdentityId, title: "bob's shared view"}};
  SandstormPermissions.createNewApiToken(globalDb, {identityId: data.aliceIdentityId,
                                                    accountId: data.aliceUserId},
                                         data.grainId,
                                         "new token petname 1", {roleId: 1}, owner);
  SandstormPermissions.createNewApiToken(globalDb, {identityId: data.aliceIdentityId,
                                                    accountId: data.aliceUserId},
                                         data.grainId,
                                         "new token petname 2", {roleId: 2}, owner);

  test.isTrue(
    SandstormPermissions.mayOpenGrain(globalDb, {grain: {_id: data.grainId,
                                                         identityId: data.bobIdentityId}}));
  test.equal(SandstormPermissions.grainPermissions(globalDb,
                                                   {grain: {_id: data.grainId,
                                                            identityId: data.bobIdentityId}},
                                                   viewInfo),
             [true, false, true]);
});
