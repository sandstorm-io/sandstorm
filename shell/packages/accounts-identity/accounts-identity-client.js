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

const LoginIdentitiesOfLinkedAccounts = new Mongo.Collection("loginIdentitiesOfLinkedAccounts");
// Pseudocollection populated by the `accountsOfIdentity(sourceIdentityId)` subscription. Contains
// information about all login identities for all accounts that have the "source identity" linked.
//   _id: Identity ID of the login identity;
//   profile: Profile object for the login identity, as in the Users collection. Profile defaults
//            and the intrinsic name have already been filled in.
//   loginAccountId: ID of the account that the login identity can log in to.
//   sourceIdentityId: Identity ID of the source identity.

const linkingNewIdentity = new ReactiveVar(false);

Accounts.isLinkingNewIdentity = function () {
  return linkingNewIdentity.get() || !!sessionStorage.getItem("linkingIdentityLoginToken");
};

Template.identityLoginInterstitial.onCreated(function () {
  const _this = this;
  this.error = new ReactiveVar(null);
  this._state = new ReactiveVar({ justLoggingIn: true });
  const token = sessionStorage.getItem("linkingIdentityLoginToken");
  if (token) {
    this._state.set({ linkingIdentity: true });
    sessionStorage.removeItem("linkingIdentityLoginToken");
    linkingNewIdentity.set(true);

    Meteor.call("linkIdentityToAccount", token, function (err, result) {
      if (err) {
        // TODO(cleanup): Figure out a better way to get this data to the /account page.
        if (err.error === "alreadyLinked") {
          Session.set("linkingIdentityError", { alreadyLinked: true });
        } else {
          Session.set("linkingIdentityError", err.toString());
        }
      } else {
        Session.set("linkingIdentityError");
      }

      Meteor.loginWithToken(token, () => linkingNewIdentity.set(false));
    });
  } else {
    const sub = this.subscribe("accountsOfIdentity", Meteor.userId());
    this.autorun(() => {
      if (sub.ready()) {
        const loginAccount = LoginIdentitiesOfLinkedAccounts.findOne({
          _id: Meteor.userId(),
          sourceIdentityId: Meteor.userId(),
        });
        if (loginAccount) {
          Meteor.loginWithIdentity(loginAccount.loginAccountId, function (err) {
            if (err) {
              console.error("error", err);
              _this.error.set(err.reason);
            }
          });
        } else if (!LoginIdentitiesOfLinkedAccounts.findOne({ sourceIdentityId: Meteor.userId() })) {
          Meteor.call("createAccountForIdentity", function (err, result) {
            if (err) {
              console.log("error", err);
            }
          });
        } else if ("justLoggingIn" in this._state.get()) {
          this._state.set({ needInput: true });
        }
      }
    });
  }
});

Template.identityLoginInterstitial.helpers({
  needInput: function () {
    return "needInput" in Template.instance()._state.get();
  },

  linkingIdentity: function () {
    return "linkingIdentity" in Template.instance()._state.get();
  },

  currentIdentity: function () {
    const identity = Meteor.user();
    SandstormDb.fillInProfileDefaults(identity);
    SandstormDb.fillInIntrinsicName(identity);
    SandstormDb.fillInPictureUrl(identity);
    return identity;
  },

  nonloginAccounts: function () {
    return LoginIdentitiesOfLinkedAccounts.find().fetch().map(function (identity) {
      SandstormDb.fillInPictureUrl(identity);
      return identity;
    });
  },

  error: function () {
    return Template.instance().error.get();
  },
});

Template.identityLoginInterstitial.events({
  "click button.logout": function () {
    Meteor.logout();
  },

  "click button.unlink": function () {
    const userId = event.target.getAttribute("data-user-id");
    const user = Meteor.user();
    const identityId = user && user._id;
    const loginIdentity = LoginIdentitiesOfLinkedAccounts.findOne({ loginAccountId: userId });
    const name = loginIdentity.profile.name;
    if (window.confirm("Are you sure you want to unlink your identity from the account of " +
                       name + " ?")) {
      Meteor.call("unlinkIdentity", userId, identityId, function (err, result) {
        if (err) {
          console.log("error: ", err);
        }
      });
    }
  },
});

Template.identityManagementButtons.events({
  "click button.unlink-identity": function (event, instance) {
    if (instance.data.isLogin && Meteor.user().loginIdentities.length <= 1) {
      window.alert("You are not allowed to unlink your only login identity.");
    } else if (window.confirm("Are you sure you want to unlink this identity? " +
                              "You will lose access to grains that were shared to this identity.")) {
      const identityId = event.target.getAttribute("data-identity-id");
      Meteor.call("unlinkIdentity", Meteor.userId(), identityId, function (err, result) {
        if (err) {
          console.log("err: ", err);
        }
      });
    }
  },

  "change input.toggle-login": function (event, instance) {
    const identityId = event.target.getAttribute("data-identity-id");
    Meteor.call("setIdentityAllowsLogin", identityId, event.target.checked, function (err, result) {
      if (err) {
        instance.data.setActionCompleted({ error: err });
      } else {
        instance.data.setActionCompleted({ success: "changed login ability of identity" });
      }
    });
  },
});

Template.identityManagementButtons.helpers({
  disableToggleLogin: function () {
    if (this.isLogin) {
      if (Meteor.user().loginIdentities.length <= 1) {
        return { why: "You must have at least one login identity." };
      }
    } else {
      if (LoginIdentitiesOfLinkedAccounts.findOne({ sourceIdentityId: this._id,
                                                   loginAccountId: { $ne: Meteor.userId() }, })) {
        return { why: "A shared identity is not allowed to be promoted to a login identity." };
      }

      if (this.isDemo) {
        return { why: "Demo identities cannot be used to log in." };
      }
    }
  },
});

Template.loginIdentitiesOfLinkedAccounts.onCreated(function () {
  if (this.data._id) {
    this.subscribe("accountsOfIdentity", this.data._id);
  }

  this._showOtherAccounts = new ReactiveVar(false);
});

Template.loginIdentitiesOfLinkedAccounts.helpers({
  showOtherAccounts: function () {
    return Template.instance()._showOtherAccounts.get();
  },

  getOtherAccounts: function () {
    const id = Template.instance().data._id;
    return LoginIdentitiesOfLinkedAccounts.find({ sourceIdentityId: id,
                                                 loginAccountId: { $ne: Meteor.userId() }, })
        .fetch().map(function (identity) {
      SandstormDb.fillInPictureUrl(identity);
      return identity;
    });
  },
});

Template.loginIdentitiesOfLinkedAccounts.events({
  "click button.show-other-accounts": function (event, instance) {
    instance._showOtherAccounts.set(true);
  },

  "click button.hide-other-accounts": function (event, instance) {
    instance._showOtherAccounts.set(false);
  },

  "click button.unlink": function (event, instance) {
    const userId = event.target.getAttribute("data-user-id");
    const identityId = instance.data._id;
    const loginIdentity = LoginIdentitiesOfLinkedAccounts.findOne({ loginAccountId: userId });
    const name = loginIdentity.profile.name;
    if (window.confirm("Are you sure you want to unlink this identity from the account of " +
                       name + " ?")) {
      Meteor.call("unlinkIdentity", userId, identityId, function (err, result) {
        if (err) {
          console.log("error: ", err);
        }
      });
    }
  },
});

Template.identityPicker.events({
  "click button.pick-identity": function (event, instance) {
    instance.data.onPicked(event.currentTarget.getAttribute("data-identity-id"));
  },
});

Template.identityPicker.helpers({
  isCurrentIdentity: function () {
    return this._id === Template.instance().data.currentIdentityId;
  },
});

Template.identityCard.helpers({
  intrinsicName: function () {
    if (this.privateIntrinsicName) {
      return this.privateIntrinsicName;
    } else {
      return this.profile && this.profile.intrinsicName;
    }
  },
});

Meteor.loginWithIdentity = function (accountId, callback) {
  // Attempts to log into the account with ID `accountId`.

  check(accountId, String);
  const identity = Meteor.user();

  Accounts.callLoginMethod({
    methodName: "loginWithIdentity",
    methodArguments: [accountId],
    userCallback: function (error, result) {
      if (error) {
        callback && callback(error);
      } else {
        if (identity.profile.service !== "demo") {
          Accounts.setCurrentIdentityId(identity._id);
        }

        callback && callback();
      }
    },
  });
};

const CURRENT_IDENTITY_KEY = "Accounts.CurrentIdentityId";

Accounts.getCurrentIdentityId = function () {
  // TODO(cleanup): `globalGrains` is only in scope here because of a Meteor bug. We should figure
  //   out a better way to track a reference to it.
  const activeGrain = globalGrains.getActive();
  if (activeGrain) {
    return activeGrain.identityId();
  }

  const identityId = Session.get(CURRENT_IDENTITY_KEY);
  const identityIds = SandstormDb.getUserIdentityIds(Meteor.user());
  if (identityId && (identityIds.indexOf(identityId) != -1)) {
    return identityId;
  } else {
    return identityIds[0];
  }
};

Accounts.setCurrentIdentityId = function (identityId) {
  check(identityId, String);

  // TODO(cleanup): `globalGrains` is only in scope here because of a Meteor bug. We should figure
  //   out a better way to track a reference to it.
  const activeGrain = globalGrains.getActive();
  if (activeGrain) {
    return activeGrain.switchIdentity(identityId);
  }

  Session.set(CURRENT_IDENTITY_KEY, identityId);
};
