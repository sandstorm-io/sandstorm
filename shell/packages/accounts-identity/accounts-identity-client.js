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
  // An exhaustive list of the top-level states this interstitial may be in.
  // Each state may include an object with additional context-specific information.
  //
  //   * loading                 Waiting on subscriptions to finish loading
  //   * creatingAccount         We have sent a createAccountForIdentity call and are awaiting the
  //                             reply
  //   * accountCreationFailed   The createAccountForIdentity call failed.  Value is the Error.
  //   * loggingInWithIdentity   We have sent a loginWithIdentity call and are awaiting the reply
  //   * loginWithIdentityFailed The loginWithIdentity call failed.  Value is the Error.
  //   * loggingInWithToken      We have started logging in with a token and are awaiting the reply
  //   * loginWithTokenFailed    The loginWithToken call failed.  Value is the Error.
  //   * linkingIdentity         We have sent a linkIdentityToAccount call and are awaiting the
  //                             reply
  //   * noLoginIdentities       Subscriptions loaded, but we can neither login, create, nor link an
  //                             account.  We require input.
  //
  // When in the noLoginIdentities state, we also keep track of some additional substates in a
  // separate variable, unlinkIdentityState:
  //
  //   * unlinkIdentityState     Object containing one of the following:
  //       * { idle: true }           Awaiting input
  //       * { confirming: Object }   Confirming that you want to unlink that identity
  //       * { unlinking: Object }    We have sent a unlinkIdentity call and are awaiting the reply
  //       * { success: Object }      We have successfully unlinked an identity, details of which
  //                                  are in the Object
  //       * { error: Object }        Our unlinkIdentity call failed.  The object contains both the
  //                                  call's error reply at key "error" as well as any other keys
  //                                  from the context that were in the `unlinking:` object, to
  //                                  preserve the context-specific UI hints in the popup.
  //
  // Note that linkingIdentityError is propagated up to the field in Session, since its lifecycle
  // starts and ends outside the scope of this particular interstitial, and regardless of whether
  // we succeed or fail to link an identity, we perform a token login back to the user's previous
  // session.
  this._state = new ReactiveVar({ loading: true });
  this.createAccountError = new ReactiveVar(undefined);
  this.loginError = new ReactiveVar(undefined);
  this.unlinkIdentityState = new ReactiveVar({ idle: true });

  this.loginWithIdentity = (accountId, identityId) => {
    this._state.set({ loggingInWithIdentity: true });
    Meteor.loginWithIdentity(accountId, (err) => {
      if (err) {
        console.log(err);
        this._state.set({ loginWithIdentityFailed: err });
      } else {
        // Successful login.
        // If the user is already visiting a grain, assume the identity with which they've
        // logged in is the identity they would like to use on that grain.
        const current = Router.current();
        if (current.route.getName() === "shared") {
          current.state.set("identity-chosen-by-login", identityId);
        }
      }
    });
  };

  const token = sessionStorage.getItem("linkingIdentityLoginToken");
  if (token) {
    this._state.set({ linkingIdentity: true });
    sessionStorage.removeItem("linkingIdentityLoginToken");
    linkingNewIdentity.set(true);

    Meteor.call("linkIdentityToAccount", token, (err) => {
      if (err) {
        // TODO(cleanup): Figure out a better way to get this data to the /account page.
        if (err.error === "alreadyLinked") {
          Session.set("linkingIdentityError", { alreadyLinked: true });
        } else {
          Session.set("linkingIdentityError", err.toString());
        }
      } else {
        // Success.
        Session.set("linkingIdentityError", undefined);
      }

      this._state.set({ loggingInWithToken: true });
      Meteor.loginWithToken(token, (err) => {
        linkingNewIdentity.set(false);
        if (err) {
          this._state.set({ loginWithTokenFailed: err });
        } else {
          // We logged back in with the token successfully.  This template will be removed from the
          // layout momentarily.
        }
      });
    });
  } else {
    this.autorun(() => {
      const identityId = Meteor.userId();

      const accountsOfIdentitySub = this.subscribe("accountsOfIdentity", identityId);
      if (accountsOfIdentitySub.ready()) {
        const currentState = this._state.get();
        if (currentState.loading || currentState.noLoginIdentities) {
          // If we're in one of the two states that should react to DB changes,
          // see if we should start an RPC.
          const loginAccount = LoginIdentitiesOfLinkedAccounts.findOne({
            _id: identityId,
            sourceIdentityId: identityId,
          });

          if (loginAccount) {
            this.loginWithIdentity(loginAccount.loginAccountId, identityId);
          } else if (!LoginIdentitiesOfLinkedAccounts.findOne({ sourceIdentityId: identityId })) {
            this._state.set({ creatingAccount: true });
            Meteor.call("createAccountForIdentity", (err, result) => {
              if (err) {
                console.log("error", err);
                this._state.set({ accountCreationFailed: err });
              } else {
                // Log in as the account we just created.
                this.loginWithIdentity(result, identityId);
              }
            });
          } else {
            if (currentState.loading) {
              this._state.set({ noLoginIdentities: true });
            }
          }
        }
      }
    });
  }
});

Template.identityLoginInterstitial.helpers({
  // Top-level states
  state() {
    return Template.instance()._state.get();
  },

  unlinkIdentityState() {
    return Template.instance().unlinkIdentityState.get();
  },

  currentIdentity() {
    const identity = Meteor.user();
    SandstormDb.fillInProfileDefaults(identity);
    SandstormDb.fillInIntrinsicName(identity);
    SandstormDb.fillInPictureUrl(identity);
    return identity;
  },

  nonloginAccounts() {
    const identities = LoginIdentitiesOfLinkedAccounts.find().fetch().map((identity) => {
      SandstormDb.fillInPictureUrl(identity);
      return identity;
    });
    const grouped = _.groupBy(identities, "loginAccountId");
    const accountIds = _.keys(grouped);
    const accounts = accountIds.map((accountId) => {
      return {
        accountId,
        identities: grouped[accountId],
      };
    });
    return accounts;
  },

  modalContext() {
    const instance = Template.instance();
    const state = instance.unlinkIdentityState.get();
    return state.confirming || state.unlinking || state.error;
  },

  cancelUnlink() {
    const instance = Template.instance();
    return () => {
      instance.unlinkIdentityState.set({
        idle: true,
      });
    };
  },
});

Template.identityLoginInterstitial.events({
  "click button.logout"() {
    Meteor.logout();
  },

  "click button.unlink"(evt) {
    const instance = Template.instance();
    const userId = evt.target.getAttribute("data-user-id");
    const user = Meteor.user();
    const identityId = user && user._id;
    const loginIdentity = LoginIdentitiesOfLinkedAccounts.findOne({ loginAccountId: userId });
    const name = loginIdentity.profile.name;
    instance.unlinkIdentityState.set({
      confirming: {
        userId,
        identityId,
        loginIdentity,
        name,
      },
    });
  },

  "click button[name=confirm-unlink]"(evt) {
    const instance = Template.instance();
    const oldState = instance.unlinkIdentityState.get();
    const context = oldState.confirming;
    instance.unlinkIdentityState.set({ unlinking: context });
    Meteor.call("unlinkIdentity", context.userId, context.identityId, function (err, result) {
      if (err) {
        console.log("error: ", err);
        const errorContext = _.extend({ error: err }, context);
        instance.unlinkIdentityState.set({ error: errorContext });
      } else {
        instance.unlinkIdentityState.set({ success: context });
      }
    });
  },

  "click button[name=cancel-unlink]"(evt) {
    const instance = Template.instance();
    instance.unlinkIdentityState.set({
      idle: true,
    });
  },
});

Template.identityManagementButtons.events({
  "click button.unlink-identity"(evt, instance) {
    if (instance.data.isLogin && Meteor.user().loginIdentities.length <= 1) {
      window.alert("You are not allowed to unlink your only login identity.");
    } else if (window.confirm("Are you sure you want to unlink this identity? " +
                              "You will lose access to grains that were shared to this identity.")) {
      const identityId = evt.currentTarget.getAttribute("data-identity-id");
      Meteor.call("unlinkIdentity", Meteor.userId(), identityId, function (err, result) {
        if (err) {
          console.log("err: ", err);
        }
      });
    }
  },

  "change input.toggle-login"(evt, instance) {
    const identityId = evt.currentTarget.getAttribute("data-identity-id");
    Meteor.call("setIdentityAllowsLogin", identityId, evt.currentTarget.checked, function (err, result) {
      if (err) {
        instance.data.setActionCompleted({ error: err });
      } else {
        instance.data.setActionCompleted({ success: "changed login ability of identity" });
      }
    });
  },
});

Template.identityManagementButtons.helpers({
  disableToggleLogin() {
    const instance = Template.instance();
    if (instance.data.isLogin) {
      if (Meteor.user().loginIdentities.length <= 1) {
        return { why: "You must have at least one login identity." };
      }
    } else {
      if (LoginIdentitiesOfLinkedAccounts.findOne({
          sourceIdentityId: instance.data._id,
          loginAccountId: {
            $ne: Meteor.userId(),
          },
        })) {
        return { why: "A shared identity is not allowed to be promoted to a login identity." };
      }

      if (instance.data.isDemo) {
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
  showOtherAccounts() {
    return Template.instance()._showOtherAccounts.get();
  },

  getOtherAccounts() {
    const id = Template.instance().data._id;
    return LoginIdentitiesOfLinkedAccounts.find({
      sourceIdentityId: id,
      loginAccountId: {
        $ne: Meteor.userId(),
      },
    }).fetch().map((identity) => {
      SandstormDb.fillInPictureUrl(identity);
      return identity;
    });
  },
});

Template.loginIdentitiesOfLinkedAccounts.events({
  "click button.show-other-accounts"(evt, instance) {
    instance._showOtherAccounts.set(true);
  },

  "click button.hide-other-accounts"(evt, instance) {
    instance._showOtherAccounts.set(false);
  },

  "click button.unlink"(evt, instance) {
    const userId = evt.currentTarget.getAttribute("data-user-id");
    const identityId = instance.data._id;
    const loginIdentity = LoginIdentitiesOfLinkedAccounts.findOne({ loginAccountId: userId });
    const name = loginIdentity.profile.name;
    if (window.confirm("Are you sure you want to unlink this identity from the account of " +
                       name + " ?")) {
      Meteor.call("unlinkIdentity", userId, identityId, (err, result) => {
        if (err) {
          console.log("error: ", err);
        }
      });
    }
  },
});

Template.identityPicker.events({
  "click button.pick-identity"(evt, instance) {
    instance.data.onPicked(evt.currentTarget.getAttribute("data-identity-id"));
  },
});

Template.identityPicker.helpers({
  isCurrentIdentity() {
    const instance = Template.instance();
    return instance.data._id === Template.instance().data.currentIdentityId;
  },
});

Template.identityCard.helpers({
  intrinsicName() {
    const instance = Template.instance();
    if (instance.data.privateIntrinsicName) {
      return instance.data.privateIntrinsicName;
    } else {
      return instance.data.profile && instance.data.profile.intrinsicName;
    }
  },
});

Template.identityCardSignInButton.onCreated(function () {
  this._clicked = new ReactiveVar(false);
  this._form = new ReactiveVar();
});

Template.identityCardSignInButton.events({
  "click button.sign-in"(evt, instance) {
    instance._clicked.set(true);

    const data = Template.instance().data;
    const name = data.identity.profile.service;
    const result = Accounts.identityServices[name].initiateLogin(data.identity.loginId);
    if ("form" in result) {
      const loginTemplate = Accounts.identityServices[name].loginTemplate;
      instance._form.set({
        loginId: data.identity.loginId,
        data: loginTemplate.data,
        name: loginTemplate.name,
      });
    }
  },
});

Template.identityCardSignInButton.helpers({
  clicked() {
    return Template.instance()._clicked.get();
  },

  form() {
    return Template.instance()._form.get();
  },
});

Meteor.loginWithIdentity = function (accountId, callback) {
  // Attempts to log into the account with ID `accountId`.

  check(accountId, String);
  const identity = Meteor.user();

  Accounts.callLoginMethod({
    methodName: "loginWithIdentity",
    methodArguments: [accountId],
    userCallback: function (error) {
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
  Session.set(CURRENT_IDENTITY_KEY, identityId);
};
