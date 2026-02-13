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

import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { Accounts } from "meteor/accounts-base";
import { _ } from "meteor/underscore";

import { SandstormDb } from "/imports/sandstorm-db/db";
import { SandstormBackend } from "/imports/server/backend";

const deleteUnusedAccountForCredentialAsync = async function (db, backend, credentialId) {
  check(credentialId, String);
  const account = await db.collections.users.findOneAsync({ "loginCredentials.id": credentialId });
  if (account &&
      account.loginCredentials.length == 1 &&
      account.nonloginCredentials.length == 0 &&
      !(await db.collections.grains.findOneAsync({ userId: account._id }, { fields: {} })) &&
      !(await db.collections.apiTokens.findOneAsync({ accountId: account._id })) &&
      (!account.plan || account.plan === "free") &&
      !(account.payments && account.payments.id) &&
      !(await db.collections.contacts.findOneAsync({ ownerId: account._id }))) {
    await db.collections.users.removeAsync({ _id: account._id });
    backend.deleteUser(account._id);
  }
};

const linkCredentialToAccountInternal = async function (db, backend, credentialId, accountId, allowLogin) {
  // Links the credential to the account. If `allowLogin` is true, grants the credential login access
  // if possible. Makes the account durable if it is a demo account.

  check(db, SandstormDb);
  check(backend, SandstormBackend);
  check(credentialId, String);
  check(accountId, String);

  const accountUser = await Meteor.users.findOneAsync({ _id: accountId });
  if (!accountUser) {
    throw new Meteor.Error(404, "No account found with ID " + accountId);
  }

  if (accountUser.type !== "account") {
    throw new Meteor.Error(400, "Cannot link a credential to another credential.");
  }

  if (accountUser.expires && !Meteor.settings.public.allowUninvited) {
    throw new Meteor.Error(403, "Sorry, this server does not allow demo users to upgrade to full accounts.");
  }

  if (!!_.findWhere(accountUser.loginCredentials, { id: credentialId }) ||
      !!_.findWhere(accountUser.nonloginCredentials, { id: credentialId })) {
    throw new Meteor.Error("alreadyLinked",
      "Cannot link a credential that's alread linked to this account.");
  }

  const credentialUser = await Meteor.users.findOneAsync({ _id: credentialId });

  if (!credentialUser) {
    throw new Meteor.Error(404, "No credential found with ID " + credentialId);
  }

  if (!credentialUser.profile) {
    throw new Meteor.Error(400, "Cannot link an account to another account");
  }

  await deleteUnusedAccountForCredentialAsync(db, backend, credentialUser._id);
  if (await Meteor.users.findOneAsync({ "loginCredentials.id": credentialUser._id })) {
    throw new Meteor.Error(403,
                           "Cannot link a credential that can already log into another account");
  }

  const alreadyLinked = !!(await Meteor.users.findOneAsync({ "nonloginCredentials.id": credentialUser._id }));

  const pushModifier = (alreadyLinked || !allowLogin)
        ? { nonloginCredentials: { id: credentialUser._id } }
        : { loginCredentials: { id: credentialUser._id } };

  let modifier;
  if (accountUser.expires) {
    if (alreadyLinked) {
      throw new Meteor.Error(403, "Cannot create an account for a credential that's " +
                                  "already linked to another account.");
    }

    modifier = {
      $push: pushModifier,
      $unset: { expires: 1 },
      $set: { upgradedFromDemo: Date.now() },
    };
    if (db.isReferralEnabled()) {
      // Demo users never got the referral notification. Send it now:
      db.sendReferralProgramNotification(accountUser._id);
    }

  } else {
    modifier = { $push: pushModifier };
  }

  // Make sure not to add the same credential twice.
  await Meteor.users.updateAsync({ _id: accountUser._id,
                                   "nonloginCredentials.id": { $ne: credentialUser._id },
                                   "loginCredentials.id": { $ne: credentialUser._id }, },
                                 modifier);

  if (accountUser.expires) {
    const demoCredentialId = SandstormDb.getUserCredentialIds(accountUser)[0];
    await Meteor.users.updateAsync({ _id: demoCredentialId },
                                   { $unset: { expires: 1 },
                                     $set: { upgradedFromDemo: Date.now() }, });

    // The account's existing profile is just "Demo User". Import the new credential's profile.
    await SandstormDb.fillInProfileDefaultsAsync(credentialUser, credentialUser.profile);

    // Mark the demo credential as nonlogin. It'd be nicer if the credential started out as nonlogin,
    // but to get that to work we would need to adjust the account creation and first login logic.
    await Meteor.users.updateAsync({ _id: accountUser._id,
                                     "loginCredentials.id": demoCredentialId,
                                     "nonloginCredentials.id": { $not: { $eq: demoCredentialId } }, },
                                   { $pull: { loginCredentials: { id: demoCredentialId } },
                                     $push: { nonloginCredentials: { id: demoCredentialId } },
                                     $set: { profile: credentialUser.profile } });
  }
};

Meteor.methods({
  loginWithCredential: async function (accountUserId) {
    // Logs into the account with ID `accountUserId`. Throws an exception if the current user is
    // not a credential user listed in the account's `loginCredentials` field. This method is not
    // intended to be called directly; client-side code should only invoke it through
    // `Meteor.loginWithCredential()`, which additionally maintains the standard Meteor client-side
    // login state.

    check(accountUserId, String);

    const credentialUser = await Meteor.userAsync();
    if (!credentialUser || !credentialUser.profile) {
      throw new Meteor.Error(403, "Must be already logged in as an credential.");
    }

    const accountUser = await Meteor.users.findOneAsync({ _id: accountUserId });
    if (!accountUser) {
      throw new Meteor.Error(404, "No such user found: " + accountUserId);
    }

    const linkedCredential = _.findWhere(accountUser.loginCredentials, { id: credentialUser._id });

    if (!linkedCredential) {
      throw new Meteor.Error(403, "Current credential is not a login credential for account "
                             + accountUserId);
    }

    return Accounts._loginMethod(this, "loginWithCredential", [accountUserId],
                                 "credential", function () { return { userId: accountUserId }; });
  },

  createAccountForCredential: async function () {
    // Creates a new account for the currently-logged-in credential.

    const user = await Meteor.userAsync();
    if (!user || user.type !== "credential") {
      throw new Meteor.Error(403, "Must be logged in as a credential in order to create an account.");
    }

    const existingAccount = await Meteor.users.findOneAsync({
      $or: [
        { "loginCredentials.id": user._id },
        { "nonloginCredentials.id": user._id },
      ],
    });

    if (existingAccount) {
      throw new Meteor.Error(403, "Cannot create an account for a credential that's already " +
                                  "linked to another account.");
    }

    const newUser = {
      type: "account",
      loginCredentials: [{ id: user._id }],
      nonloginCredentials: [],
    };
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
      if (user.appDemoId) {
        newUser.appDemoId = user.appDemoId;
      }
    }

    await SandstormDb.fillInProfileDefaultsAsync(user, user.profile);
    const options = { profile: user.profile };

    // This will throw an error if the credential has been added as a login credential to some
    // other account while we were executing the body of this method.
    return Accounts.insertUserDoc(options, newUser);
  },

  linkCredentialToAccount: async function (token) {
    // Links the credential of the current user to the account that has `token` as a resume token.
    // If the account is a demo account, makes the account durable and gives the credential login
    // access to it.

    check(token, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Cannot link to account if not logged in.");
    }

    const hashed = Accounts._hashLoginToken(token);
    const accountUser = await Meteor.users.findOneAsync({ "services.resume.loginTokens.hashedToken": hashed });
    if (!accountUser) {
      throw new Meteor.Error(403, "Invalid or expired linking token.");
    }

    await linkCredentialToAccountInternal(this.connection.sandstormDb, this.connection.sandstormBackend,
                                          this.userId, accountUser._id, true);
  },

  unlinkCredential: async function (accountUserId, credentialId) {
    // Unlinks the credential with ID `credentialId` from the account with ID `accountUserId`.

    check(credentialId, String);
    check(accountUserId, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Not logged in.");
    }

    const accountUser = await Meteor.users.findOneAsync({
      _id: this.userId,
      $or: [
        { "loginCredentials.id": credentialId },
        { "nonloginCredentials.id": credentialId },
      ],
    }, { fields: { _id: 1 } });

    if (!accountUser) {
      throw new Meteor.Error(403, "Current user does not own credential " + credentialId);
    }

    await Meteor.users.updateAsync({
      _id: accountUserId,
    }, {
      $pull: {
        nonloginCredentials: { id: credentialId },
        loginCredentials: { id: credentialId },
      },
    });
  },

  setCredentialAllowsLogin: async function (credentialId, allowLogin) {
    // Sets whether the current account allows the credential with ID `credentialId` to log in.

    check(credentialId, String);
    check(allowLogin, Boolean);
    if (!this.userId) {
      throw new Meteor.Error(403, "Not logged in.");
    }

    const accountUser = await Meteor.users.findOneAsync({
      _id: this.userId,
      $or: [
        { "loginCredentials.id": credentialId },
        { "nonloginCredentials.id": credentialId },
      ],
    }, { fields: { _id: 1 } });

    if (!accountUser) {
      throw new Meteor.Error(403, "Current user does not own credential " + credentialId);
    }

    if (allowLogin) {
      await Meteor.users.updateAsync({ _id: this.userId,
                                       "nonloginCredentials.id": credentialId,
                                       "loginCredentials.id": { $not: { $eq: credentialId } }, },
                                     { $pull: { nonloginCredentials: { id: credentialId } },
                                       $push: { loginCredentials: { id: credentialId } }, });
    } else {
      await Meteor.users.updateAsync({ _id: this.userId,
                                       "loginCredentials.id": credentialId,
                                       "nonloginCredentials.id": { $not: { $eq: credentialId } }, },
                                     { $pull: { loginCredentials: { id: credentialId } },
                                       $push: { nonloginCredentials: { id: credentialId } }, });
    }
  },

  logoutCredentialsOfCurrentAccount: async function () {
    // Logs out all credentials that are allowed to log in to the current account.
    const user = await Meteor.userAsync();
    if (user && user.loginCredentials) {
      await Promise.all(user.loginCredentials.map((credential) => {
        return Meteor.users.updateAsync({ _id: credential.id }, { $set: { "services.resume.loginTokens": [] } });
      }));
    }
  },
});

Accounts.linkCredentialToAccount = async function (db, backend, credentialId, accountId, allowLogin) {
  // Links the credential to the account. If the account is a demo account, makes it durable.
  // If `allowLogin` is true, attempts to give the credential login access.
  check(db, SandstormDb);
  check(backend, SandstormBackend);
  check(credentialId, String);
  check(accountId, String);
  check(allowLogin, Boolean);
  await linkCredentialToAccountInternal(db, backend, credentialId, accountId, allowLogin);
};

Meteor.publish("accountsOfCredential", async function (credentialId) {
  check(credentialId, String);
  if (!await SandstormDb.ensureSubscriberHasCredential(this, credentialId)) return;

  // Map from credential ID to `true` for each credential we've published already.
  const loginCredentials = {};

  const _this = this;
  async function addCredentialsOfAccount(account) {
    for (const credential of account.loginCredentials) {
      if (!(credential.id in loginCredentials)) {
        const user = await Meteor.users.findOneAsync({ _id: credential.id });
        if (user) {
          user.intrinsicName = SandstormDb.getIntrinsicName(user);
          user.loginId = SandstormDb.getLoginId(user);
          user.serviceName = SandstormDb.getServiceName(user);

          const filteredUser = _.pick(user, "_id", "intrinsicName", "loginId", "serviceName");
          filteredUser.loginAccountId = account._id;
          filteredUser.sourceCredentialId = credentialId;
          _this.added("loginCredentialsOfLinkedAccounts", user._id, filteredUser);
        }

        loginCredentials[credential.id] = true;
      }
    }
  }

  const cursor = Meteor.users.find({
    $or: [
      { "loginCredentials.id": credentialId },
      { "nonloginCredentials.id": credentialId },
    ],
  });

  // Publish initial rows before signaling readiness so clients don't race into
  // `createAccountForCredential()` while linked-account data is still loading.
  const initialAccounts = await cursor.fetchAsync();
  for (const account of initialAccounts) {
    await addCredentialsOfAccount(account);
  }

  const handle = await cursor.observeAsync({
    added: function (account) {
      addCredentialsOfAccount(account).catch((err) => {
        console.error("accountsOfCredential added observer failed:", err);
      });
    },

    changed: function (newAccount, oldAccount) {
      addCredentialsOfAccount(newAccount).catch((err) => {
        console.error("accountsOfCredential changed observer failed:", err);
      });
    },

    removed: function (account) {
      account.loginCredentials.forEach(function (credential) {
        if (credential.id in loginCredentials) {
          _this.removed("loginCredentialsOfLinkedAccounts", credential.id);
          delete loginCredentials[credential.id];
        }
      });
    },
  });
  this.ready();

  this.onStop(function () {
    Promise.resolve(handle).then((h) => {
      if (typeof h === "function") { h(); } else if (h && typeof h.stop === "function") h.stop();
    }).catch((err) => {
      console.error("Failed to stop accountsOfCredential observer:", err);
    });
    Object.keys(loginCredentials).forEach(function (credentialId) {
      delete loginCredentials[credentialId];
    });
  });
});
