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
import { Mongo } from "meteor/mongo";
import { check } from "meteor/check";
import { SandstormDb } from "/imports/sandstorm-db/db.js";

const LoginCredentialsOfLinkedAccounts = new Mongo.Collection("loginCredentialsOfLinkedAccounts");
// Pseudocollection populated by the `accountsOfCredential(sourceCredentialId)` subscription. Contains
// information about all login credentials for all accounts that have the "source credential" linked.
//   _id: Credential ID of the login credential;
//   profile: Profile object for the login credential, as in the Users collection. Profile defaults
//            and the intrinsic name have already been filled in.
//   loginAccountId: ID of the account that the login credential can log in to.
//   sourceCredentialId: Credential ID of the source credential.

const linkingNewCredential = new ReactiveVar(false);

Accounts.isLinkingNewCredential = function () {
  return linkingNewCredential.get() || !!sessionStorage.getItem("linkingCredentialLoginToken");
};

Template.credentialLoginInterstitial.onCreated(function () {
  // An exhaustive list of the top-level states this interstitial may be in.
  // Each state may include an object with additional context-specific information.
  //
  //   * loading                    Waiting on subscriptions to finish loading
  //   * creatingAccount            We have sent a createAccountForCredential call and are awaiting
  //                                the reply
  //   * accountCreationFailed      The createAccountForCredential call failed.  Value is the Error.
  //   * loggingInWithCredential    We have sent a loginWithCredential call and are awaiting the reply
  //   * loginWithCredentialFailed  The loginWithCredential call failed.  Value is the Error.
  //   * loggingInWithToken         We have started logging in with a token and are awaiting the
  //                                reply
  //   * loginWithTokenFailed       The loginWithToken call failed.  Value is the Error.
  //   * linkingCredential          We have sent a linkCredentialToAccount call and are awaiting the
  //                                reply
  //   * credentialIsNotLoginCredential Subscriptions loaded, but we can neither login to an account
  //                                (because we are not a login credential), create an account
  //                                (because associated accounts exist already), nor link an account
  //                                (because we have no linking token).  We require user input.
  //
  // When in the credentialIsNotLoginCredential state, we also keep track of some additional substates
  // in a separate variable, unlinkCredentialState:
  //
  //   * unlinkCredentialState     Object containing one of the following:
  //       * { idle: true }           Awaiting input
  //       * { confirming: Object }   Confirming that you want to unlink that credential
  //       * { unlinking: Object }    We have sent a unlinkCredential call and are awaiting the reply
  //       * { success: Object }      We have successfully unlinked a credential, details of which
  //                                  are in the Object
  //       * { error: Object }        Our unlinkCredential call failed.  The object contains both the
  //                                  call's error reply at key "error" as well as any other keys
  //                                  from the context that were in the `unlinking:` object, to
  //                                  preserve the context-specific UI hints in the popup.
  //
  // Note that linkingCredentialError is propagated up to the field in Session, since its lifecycle
  // starts and ends outside the scope of this particular interstitial, and regardless of whether
  // we succeed or fail to link a credential, we perform a token login back to the user's previous
  // session.
  this._state = new ReactiveVar({ loading: true });
  this.createAccountError = new ReactiveVar(undefined);
  this.loginError = new ReactiveVar(undefined);
  this.unlinkCredentialState = new ReactiveVar({ idle: true });

  this.loginWithCredential = (accountId, credentialId) => {
    this._state.set({ loggingInWithCredential: true });
    Meteor.loginWithCredential(accountId, (err) => {
      if (err) {
        console.log(err);
        this._state.set({ loginWithCredentialFailed: err });
      } else {
        // Successful login.
        // If the user is already visiting a grain, assume the credential with which they've
        // logged in is the credential they would like to use on that grain.
        const current = Router.current();
        if (current.route.getName() === "shared") {
          current.state.set("credential-chosen-by-login", credentialId);
        }
      }
    });
  };

  const token = sessionStorage.getItem("linkingCredentialLoginToken");
  if (token) {
    this._state.set({ linkingCredential: true });
    sessionStorage.removeItem("linkingCredentialLoginToken");
    linkingNewCredential.set(true);

    Meteor.call("linkCredentialToAccount", token, (err) => {
      if (err) {
        // TODO(cleanup): Figure out a better way to get this data to the /account page.
        if (err.error === "alreadyLinked") {
          Session.set("linkingCredentialError", { alreadyLinked: true });
        } else {
          Session.set("linkingCredentialError", err.toString());
        }
      } else {
        // Success.
        Session.set("linkingCredentialError", undefined);
      }

      this._state.set({ loggingInWithToken: true });
      Meteor.loginWithToken(token, (err) => {
        linkingNewCredential.set(false);
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
      const credentialId = Meteor.userId();

      const accountsOfCredentialSub = this.subscribe("accountsOfCredential", credentialId);
      if (accountsOfCredentialSub.ready()) {
        const currentState = this._state.get();
        if (currentState.loading || currentState.credentialIsNotLoginCredential) {
          // If we're in one of the two states that should react to DB changes,
          // see if we should start an RPC.
          const loginAccount = LoginCredentialsOfLinkedAccounts.findOne({
            _id: credentialId,
            sourceCredentialId: credentialId,
          });

          if (loginAccount) {
            this.loginWithCredential(loginAccount.loginAccountId, credentialId);
          } else if (!LoginCredentialsOfLinkedAccounts.findOne({ sourceCredentialId: credentialId })) {
            this._state.set({ creatingAccount: true });
            Meteor.call("createAccountForCredential", (err, result) => {
              if (err) {
                console.log("error", err);
                this._state.set({ accountCreationFailed: err });
              } else {
                // Log in as the account we just created.
                this.loginWithCredential(result, credentialId);
              }
            });
          } else {
            if (currentState.loading) {
              this._state.set({ credentialIsNotLoginCredential: true });
            }
          }
        }
      }
    });
  }
});

Template.credentialLoginInterstitial.helpers({
  // Top-level states
  state() {
    return Template.instance()._state.get();
  },

  unlinkCredentialState() {
    return Template.instance().unlinkCredentialState.get();
  },

  currentCredential() {
    return Meteor.user();
  },

  nonloginAccounts() {
    const credentials = LoginCredentialsOfLinkedAccounts.find().fetch();
    const grouped = _.groupBy(credentials, "loginAccountId");
    const accountIds = _.keys(grouped);
    const accounts = accountIds.map((accountId) => {
      return {
        accountId,
        credentials: grouped[accountId],
      };
    });
    return accounts;
  },

  modalContext() {
    const instance = Template.instance();
    const state = instance.unlinkCredentialState.get();
    return state.confirming || state.unlinking || state.error;
  },

  cancelUnlink() {
    const instance = Template.instance();
    return () => {
      instance.unlinkCredentialState.set({
        idle: true,
      });
    };
  },
});

Template.credentialLoginInterstitial.events({
  "click button.logout"() {
    Meteor.logout();
  },

  "click button.unlink"(evt, instance) {
    const userId = this.account.accountId;
    const name = this.credential.intrinsicName;
    const user = Meteor.user();
    const credentialId = user && user._id;
    const loginCredential = LoginCredentialsOfLinkedAccounts.findOne({ loginAccountId: userId });

    instance.unlinkCredentialState.set({
      confirming: {
        userId,
        credentialId,
        loginCredential,
        name,
      },
    });
  },

  "click button[name=confirm-unlink]"(evt) {
    const instance = Template.instance();
    const oldState = instance.unlinkCredentialState.get();
    const context = oldState.confirming;
    instance.unlinkCredentialState.set({ unlinking: context });
    Meteor.call("unlinkCredential", context.userId, context.credentialId, function (err, result) {
      if (err) {
        console.log("error: ", err);
        const errorContext = _.extend({ error: err }, context);
        instance.unlinkCredentialState.set({ error: errorContext });
      } else {
        instance.unlinkCredentialState.set({ success: context });
      }
    });
  },

  "click button[name=cancel-unlink]"(evt) {
    const instance = Template.instance();
    instance.unlinkCredentialState.set({
      idle: true,
    });
  },
});

Template.credentialManagementButtons.events({
  "click button.unlink-credential"(evt, instance) {
    if (instance.data.isLogin && Meteor.user().loginCredentials.length <= 1) {
      window.alert("You are not allowed to unlink your only login credential.");
    } else if (window.confirm("Are you sure you want to unlink this credential? " +
                              "You will lose access to services linked through this credential.")) {
      const credentialId = evt.currentTarget.getAttribute("data-credential-id");
      Meteor.call("unlinkCredential", Meteor.userId(), credentialId, function (err, result) {
        if (err) {
          console.log("err: ", err);
        }
      });
    }
  },

  "change input.toggle-login"(evt, instance) {
    const credentialId = evt.currentTarget.getAttribute("data-credential-id");
    Meteor.call("setCredentialAllowsLogin", credentialId, evt.currentTarget.checked, function (err, result) {
      if (err) {
        instance.data.setActionCompleted({ error: err });
      } else {
        instance.data.setActionCompleted({ success: "changed login ability of credential" });
      }
    });
  },
});

Template.credentialManagementButtons.helpers({
  disableToggleLogin() {
    const instance = Template.instance();
    if (instance.data.isLogin) {
      if (Meteor.user().loginCredentials.length <= 1) {
        return { why: "You must have at least one login credential." };
      }
    } else {
      if (LoginCredentialsOfLinkedAccounts.findOne({
          sourceCredentialId: instance.data._id,
          loginAccountId: {
            $ne: Meteor.userId(),
          },
        })) {
        return { why: "A shared credential is not allowed to be promoted to a login credential." };
      }

      if (instance.data.isDemo) {
        return { why: "Demo credentials cannot be used to log in." };
      }
    }
  },
});

Template.loginCredentialsOfLinkedAccounts.onCreated(function () {
  if (this.data._id) {
    this.subscribe("accountsOfCredential", this.data._id);
  }

  this._showOtherAccounts = new ReactiveVar(false);
});

Template.loginCredentialsOfLinkedAccounts.helpers({
  showOtherAccounts() {
    return Template.instance()._showOtherAccounts.get();
  },

  getOtherAccounts() {
    const id = Template.instance().data._id;
    return LoginCredentialsOfLinkedAccounts.find({
      sourceCredentialId: id,
      loginAccountId: {
        $ne: Meteor.userId(),
      },
    }).fetch();
  },
});

Template.loginCredentialsOfLinkedAccounts.events({
  "click button.show-other-accounts"(evt, instance) {
    instance._showOtherAccounts.set(true);
  },

  "click button.hide-other-accounts"(evt, instance) {
    instance._showOtherAccounts.set(false);
  },

  "click button.unlink"(evt, instance) {
    const userId = evt.currentTarget.getAttribute("data-user-id");
    const credentialId = instance.data._id;
    const loginCredential = LoginCredentialsOfLinkedAccounts.findOne({ loginAccountId: userId });
    if (window.confirm("Are you sure you want to unlink this credential from the account of " +
                       loginCredential.intrinsicName + " ?")) {
      Meteor.call("unlinkCredential", userId, credentialId, (err, result) => {
        if (err) {
          console.log("error: ", err);
        }
      });
    }
  },
});

Template.credentialPicker.events({
  "click button.pick-credential"(evt, instance) {
    instance.data.onPicked(evt.currentTarget.getAttribute("data-credential-id"));
  },
});

Template.credentialPicker.helpers({
  isCurrentCredential() {
    // N.B. currentData() is affected by #with and #each, but Template.instance().data is not
    const currentData = Template.currentData();
    return (currentData && currentData._id) === Template.instance().data.currentCredentialId;
  },
});

Template.credentialCard.helpers({
  intrinsicName() {
    return this.intrinsicName || SandstormDb.getIntrinsicName(this, true);
  },

  serviceName() {
    return this.serviceName || SandstormDb.getServiceName(this);
  },

  profile() {
    const profile = {};
    SandstormDb.fillInProfileDefaults(this, profile);
    return profile;
  }
});

Template.credentialCardSignInButton.onCreated(function () {
  this._clicked = new ReactiveVar(false);
  this._form = new ReactiveVar();
});

Template.credentialCardSignInButton.events({
  "click button.sign-in"(evt, instance) {
    instance._clicked.set(true);

    const data = Template.instance().data;
    const name = data.credential.serviceName;
    const result = Accounts.loginServices[name].initiateLogin(data.credential.loginId);
    if ("form" in result) {
      const loginTemplate = Accounts.loginServices[name].loginTemplate;
      instance._form.set({
        loginId: data.credential.loginId,
        data: loginTemplate.data,
        name: loginTemplate.name,
      });
    }
  },
});

Template.credentialCardSignInButton.helpers({
  clicked() {
    return Template.instance()._clicked.get();
  },

  form() {
    return Template.instance()._form.get();
  },
});

Meteor.loginWithCredential = function (accountId, callback) {
  // Attempts to log into the account with ID `accountId`.

  check(accountId, String);
  const credential = Meteor.user();

  Accounts.callLoginMethod({
    methodName: "loginWithCredential",
    methodArguments: [accountId],
    userCallback: function (error) {
      if (error) {
        callback && callback(error);
      } else {
        callback && callback();
      }
    },
  });
};
