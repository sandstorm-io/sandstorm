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

Meteor.methods({
  loginWithIdentity: function (accountUserId) {
    // Logs into the account with ID `accountUserId`. Throws an exception if the current user is
    // not an identity user listed in the account's `loginIdentities` field. This method is not
    // intended to be called directly; client-side code should only invoke it through
    // `Meteor.loginWithIdentity()`, which additionally maintains the standard Meteor client-side
    // login state.

    check(accountUserId, String);

    var identityUser = Meteor.user();
    if (!identityUser) {
      throw new Meteor.Error(403, "Must be already logged in to used linked user login.");
    }

    var accountUser = Meteor.users.findOne(accountUserId);
    if (!accountUser) {
      throw new Meteor.Error(404, "No such user found: " + accountUserId);
    }

    var linkedIdentity = _.findWhere(accountUser.loginIdentities, {id: identityUser._id});

    if (!linkedIdentity) {
      throw new Meteor.Error(403, "Current identity is not a login identity for account "
                             + accountUserId);
    }

    return Accounts._loginMethod(this, "loginWithIdentity", [accountUserId],
                                 "identity", function () { return { userId: accountUserId }; });
  },

  createAccountForIdentity: function() {
    // Creates a new account for the currently-logged-in identity.

    var user = Meteor.user();
    if (!(user && user.profile)) {
      throw new Meteor.Error(403, "Must be logged in as an identity in order to create an account.");
    }

    if (Meteor.users.findOne({"loginIdentities.id": user._id})) {
      throw new Meteor.Error(403,
                             "Cannot create an account for an identity that can already a login");
    }

    var newUser = {loginIdentities: [{id: user._id}],
                   nonloginIdentities: []};
    if (user.services.dev) {
      newUser.signupKey = "devAccounts";
      if (user.services.dev.isAdmin) {
        newUser.isAdmin = true;
      }
      if (user.services.dev.hasCompletedSignup) {
        newUser.hasCompletedSignup = true;
      }
    } else if (user.expires) {
      // Demo user.
      newUser.expires = user.expires;
    }
    var options = {};

    // This will throw an error if the identity has been added as a login identity to some
    // other account while we were executing the body of this method.
    return Accounts.insertUserDoc(options, newUser);
  },

  linkIdentityToAccount: function(token) {
    // Links the identity of the current user to the account that has `token` as a resume token.
    // If the account is a demo account, attempts to gives the identity login access to the account.

    check(token, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Cannot link to account if not logged in.");
    }
    var hashed = Accounts._hashLoginToken(token);
    var accountUser = Meteor.users.findOne({"services.resume.loginTokens.hashedToken": hashed});

    if (!accountUser) {
      throw new Meteor.Error(404, "No account found for token: " + token);
    }

    if (accountUser.profile) {
      throw new Meteor.Error(400, "Cannot link an identity to another identity.");
    }

    var identityUser = Meteor.user();

    if (!identityUser.profile) {
      throw new Meteor.Error(400, "Current user is not an identity user.");
    }

    var modifier;
    if (accountUser.expires) {
      if (Meteor.users.findOne({"loginIdentities.id": identityUser._id})) {
        throw new Meteor.Error(403, "Cannot upgrade demo account with an identity that can " +
                               "already be used for login on another account.");
      }

      modifier = {$push: {loginIdentities: {id: identityUser._id}},
                  $unset: {expires: 1},
                  $set: {upgradedFromDemo: Date.now()}};
    } else {
      modifier = {$push: {nonloginIdentities: {id: identityUser._id}}};
    }

    // Make sure not to add the same identity twice.
    Meteor.users.update({_id: accountUser._id, "nonloginIdentities.id": {$ne: identityUser._id},
                        "loginIdentities.id": {$ne: identityUser._id}},
                        modifier);

    if (accountUser.expires) {
      Meteor.users.update({_id: accountUser.loginIdentities[0].id},
                          {$unset: {expires: 1},
                           $set: {upgradedFromDemo: Date.now()}});
    }
  },

  unlinkIdentity: function (accountUserId, identityId) {
    // Unlinks the identity with ID `identityId` from the account with ID `accountUserId`.

    check(identityId, String);
    check(accountUserId, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Not logged in.");
    }
    if (!this.connection.sandstormDb.userHasIdentity(this.userId, identityId)) {
      throw new Meteor.Error(403, "Current user does not own identity " + identityId);
    }

    var identityUser = Meteor.users.findOne({_id: identityId});
    Meteor.users.update({_id: accountUserId},
                        {$pull: {nonloginIdentities: {id: identityId},
                                 loginIdentities: {id: identityId}}});
  },

  setIdentityAllowsLogin: function(identityId, allowLogin) {
    // Sets whether the current account allows the identity with ID `identityId` to log in.

    check(identityId, String);
    check(allowLogin, Boolean);
    if (!this.userId) {
      throw new Meteor.Error(403, "Not logged in.");
    }
    if (!this.connection.sandstormDb.userHasIdentity(this.userId, identityId)) {
      throw new Meteor.Error(403, "Current user does not own identity " + identityId);
    }

    if (allowLogin) {
      Meteor.users.update({_id: this.userId,
                           "nonloginIdentities.id": identityId,
                           "loginIdentities.id": {$not: {$eq: identityId}}},
                          {$pull: {nonloginIdentities: {id: identityId}},
                           $push: {loginIdentities: {id: identityId}}});
    } else {
      Meteor.users.update({_id: this.userId,
                           "loginIdentities.id": identityId,
                           "nonloginIdentities.id": {$not: {$eq: identityId}}},
                          {$pull: {loginIdentities: {id: identityId}},
                           $push: {nonloginIdentities: {id: identityId}}});
    }
  },

  logoutIdentitiesOfCurrentAccount: function() {
    // Logs out all identities that are allowed to log in to the current account.
    var user = Meteor.user();
    if (user && user.loginIdentities) {
      user.loginIdentities.forEach(function(identity) {
        Meteor.users.update({_id: identity.id}, {$set: {"services.resume.loginTokens": []}});
      });
    }
  }
});

Accounts.linkIdentityToAccount = function (identityId, accountId) {
  // Links the identity to the account.

  check(identityId, String);
  check(accountId, String);

  // Make sure not to add the same identity twice.
  Meteor.users.update({_id: accountId,
                       loginIdentities: {$exists: true},
                       "nonloginIdentities.id": {$ne: identityId},
                       "loginIdentities.id": {$ne: identityId}},
                      {$push: {"nonloginIdentities": {id: identityId}}});

}

Meteor.publish("accountsOfIdentity", function (identityId) {
  check(identityId, String);
  var hasIdentityCursor =
      Meteor.users.find({$or: [{_id: identityId},
                               {_id: this.userId, "loginIdentities.id": identityId},
                               {_id: this.userId, "nonloginIdentities.id": identityId}]});
  if (hasIdentityCursor.count() == 0) return;
  var self = this;
  hasIdentityCursor.observe({removed: function () { self.stop(); }});

  // We maintain a map from identity IDs to live query handles that track profile changes.
  var loginIdentities = {};

  function addIdentitiesOfAccount(account) {
    account.loginIdentities.forEach(function(identity) {
      if (!(identity.id in loginIdentities)) {
        var user = Meteor.users.findOne({_id: identity.id});
        if (user) {
          SandstormDb.fillInProfileDefaults(user);
          SandstormDb.fillInIntrinsicName(user);
          var filteredUser = _.pick(user, "_id", "profile");
          filteredUser.loginAccountId = account._id;
          filteredUser.sourceIdentityId = identityId;
          self.added("loginIdentitiesOfLinkedAccounts", user._id, filteredUser);
        }
        loginIdentities[identity.id] =
          Meteor.users.find({_id: identity.id}, {fields: {profile: 1}}).observeChanges({
            changed: function (id, fields) {
              self.changed("loginIdentitiesOfLinkedAccounts", id, fields);
            }
          });
      }
    });
  }
  var cursor = Meteor.users.find({$or: [{"loginIdentities.id": identityId},
                                        {"nonloginIdentities.id": identityId}]});
  cursor.forEach(addIdentitiesOfAccount);
  this.ready();

  var handle = cursor.observe({
    added: function (account) {
      addIdentitiesOfAccount(account);
    },
    changed: function (newAccount, oldAccount) {
      addIdentitiesOfAccount(newAccount);
    },
    removed: function (account) {
      account.loginIdentities.forEach(function(identity) {
        if (identity.id in loginIdentities) {
          self.removed("loginIdentitiesOfLinkedAccounts", identity.id);
          loginIdentities[identity.id].stop();
          delete loginIdentities[identity.id];
        }
      });
    },
  });
  this.onStop(function() { handle.stop(); });
});
