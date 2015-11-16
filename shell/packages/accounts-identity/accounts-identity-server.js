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

  checkForLinkedAccounts: function() {
    var user = Meteor.user();
    if (user.loginIdentities) return {alreadyAccount: true};

    var loginAccount = Meteor.users.findOne({"loginIdentities.id": user._id},
                                            {fields: {_id: 1, "loginIdentities.$": 1}});

    if (loginAccount) {
      return {loginAccountId: loginAccount._id};
    }

    var nonloginAccounts = Meteor.users.find({"nonloginIdentities.id": user._id}).fetch();

    var accountUserId;
    if (nonloginAccounts.length == 0) {
      // Make a new account for this user.
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
      accountUserId = Accounts.insertUserDoc(options, newUser);
      return {loginAccountId: accountUserId};
    } else {
      var resultData = [];
      nonloginAccounts.forEach(function(account) {
        if (account.loginIdentities.length > 0) {
          var loginIdentityUser =
              Meteor.users.findOne({_id: account.loginIdentities[0].id});
          if (loginIdentityUser) {
            var userWithDefaults = SandstormDb.getUserIdentities(loginIdentityUser)[0];
            resultData.push({accountId: account._id,
                             loginIdentityUser: _.pick(userWithDefaults, "_id", "profile")});
          }
        }
      });
      return {nonloginAccounts: resultData};
    }
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
    // Unlinks `identityId` from `accountUserId`.

    check(identityId, String);
    check(accountUserId, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Not logged in.");
    }
    if (!this.connection.sandstormDb.userHasIdentity(accountUserId, identityId)) {
      throw new Meteor.Error(403, "Current user does not own identity " + identityId);
    }

    var identityUser = Meteor.users.findOne({_id: identityId});
    if (this.userId === accountUserId || this.userId === identityUser._id) {
      Meteor.users.update({_id: accountUserId},
                          {$pull: {nonloginIdentities: {id: identityId},
                                   loginIdentities: {id: identityId}}});
    } else {
      throw new Meteor.Error(403, "Not authorized to unlink identity " + identityId);
    }
  },

  setIdentityAllowsLogin: function(identityId, allowLogin) {
    check(identityId, String);
    check(allowLogin, Boolean);
    if (!this.userId) {
      throw new Meteor.Error(403, "Not logged in.");
    }
    if (!this.connection.sandstormDb.userHasIdentity(this.userId, identityId)) {
      throw new Meteor.Error(403, "Current user does not own identity " + identityId);
    }

    var user = Meteor.user();
    var currentlyLogin = !!_.findWhere(user.loginIdentities, {id: identityId});
    var currentlyNonlogin = !!_.findWhere(user.nonloginIdentities, {id: identityId});
    if (allowLogin && !currentlyLogin && currentlyNonlogin) {
      Meteor.users.update({_id: this.userId},
                          {$pull: {nonloginIdentities: {id: identityId}},
                           $push: {loginIdentities: {id: identityId}}});
    } else if (!allowLogin && currentlyLogin && !currentlyNonlogin) {
      Meteor.users.update({_id: this.userId},
                          {$pull: {loginIdentities: {id: identityId}},
                           $push: {nonloginIdentities: {id: identityId}}});
    } else {
      console.log("allowLogin", allowLogin);
      console.log("currentlyLogin", currentlyLogin);
      console.log("currentlyNonlogin", currentlyNonlogin);
      throw new Meteor.Error(500, "malformed user record");
    }
  },

});


