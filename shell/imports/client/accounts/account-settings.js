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
import { Template } from "meteor/templating";
import { formatFutureTime } from "/imports/dates.js";
import { ACCOUNT_DELETION_SUSPENSION_TIME } from "/imports/constants.js";
import SandstormAccountSettingsUi from "/imports/client/accounts/account-settings-ui.js";
import { SandstormDb } from "/imports/sandstorm-db/db.js";

Template.sandstormAccountSettings.onCreated(function () {
  this.autorun(() => {
    const data = Template.currentData();
    check(data, SandstormAccountSettingsUi);
  });

  this._isLinkingNewCredential = new ReactiveVar(false);
  this._actionCompleted = new ReactiveVar();
  this._logoutOtherSessionsInFlight = new ReactiveVar(false);
  this._showDeletePopup = new ReactiveVar(false);
  this._deleteSubmitting = new ReactiveVar(false);
  this._deleteError = new ReactiveVar(null);
  this._deleteConfirmed = new ReactiveVar(false);
  const _this = this;

  // TODO(cleanup): Figure out a better way to pass in this data. Perhaps it should be part of
  //   the URL?
  let err = Session.get("linkingCredentialError");
  if (err) {
    if (err.alreadyLinked) {
      this._actionCompleted.set(
        { success: "Credential was already linked to this account" });
    } else {
      this._actionCompleted.set(
        { error: "Error linking credential: " + err });
    }

    Session.set("linkingCredentialError");
  }
});

Template.sandstormAccountSettings.helpers({
  db: function () {
    return Template.instance().data._db;
  },

  isPaymentsEnabled: function () {
    return !!Meteor.settings.public.stripePublicKey;
  },

  setDocumentTitle: function () {
    document.title = "Account settings · " + Template.instance().data._db.getServerTitle();
  },

  credentials: function () {
    return _.chain(SandstormDb.getUserCredentialIds(Meteor.user()))
      .map((id) => Meteor.users.findOne({ _id: id }))
      .filter((credential) => !!credential)
      // Demo credentials don't need to be shown at all anymore.
      // TODO(cleanup): Remove demo credentials altogether when demo finishes, or maybe never
      //   create them in the first place. Be sure to wipe the database of past demo credentials.
      .filter((credential) => !credential.services.demo)
      .map((credential) => {
        credential.intrinsicName = SandstormDb.getIntrinsicName(credential, true);
        credential.serviceName = SandstormDb.getServiceName(credential);
        return credential;
      }).value();
  },

  isAccountUser: function () {
    return Meteor.user() && !!Meteor.user().loginCredentials;
  },

  isLinkingNewCredential: function () {
    return Template.instance()._isLinkingNewCredential.get();
  },

  verifiedEmails: function () {
    return Meteor.user() && SandstormDb.getUserEmails(Meteor.user())
      .filter(function (e) { return !!e.verified; });
  },

  needsVerifiedEmail: function () {
    return Meteor.user() && SandstormDb.getUserEmails(Meteor.user())
      .filter(function (e) { return !!e.verified; }).length == 0;
  },

  actionCompleted: function () {
    return Template.instance()._actionCompleted.get();
  },

  setActionCompleted: function () {
    const actionCompleted = Template.instance()._actionCompleted;
    return function (x) { actionCompleted.set(x); };
  },

  linkingNewCredentialData: function () {
    const instance = Template.instance();
    return {
      doneCallback: function () {
        instance._isLinkingNewCredential.set(false);
        instance._actionCompleted.set({ success: "credential added" });
      },
    };
  },

  emailLoginFormData: function () {
    const instance = Template.instance();
    return {
      linkingNewCredential: {
        doneCallback: function () {
          const input = instance.find("input[name='email']");
          if (input) {
            input.value = "";
          };

          instance._actionCompleted.set({ success: "credential added" });
        },
      },
      sendButtonText: "Confirm",
    };
  },

  logoutOtherSessionsInFlight: function () {
    return Template.instance()._logoutOtherSessionsInFlight.get();
  },

  showDeletePopup: function () {
    return Template.instance()._showDeletePopup.get();
  },

  cancelDelete() {
    const instance = Template.instance();
    return () => {
      instance._showDeletePopup.set(false);
    };
  },

  disableDelete() {
    const instance = Template.instance();
    return instance._deleteSubmitting.get() || !instance._deleteConfirmed.get();
  },

  deleteError() {
    const instance = Template.instance();
    return instance._deleteError.get();
  },

  showDeleteButton: function () {
    return !Template.instance().data._db.isUserInOrganization(Meteor.user());
  },

  credentialManagementButtonsData: function () {
    const user = Meteor.user();
    const credentialId = this._id;
    const actionCompleted = Template.instance()._actionCompleted;
    return {
      _id: credentialId,
      isLogin: user.loginCredentials && !!_.findWhere(user.loginCredentials, { id: credentialId }),
      isDemo: this.serviceName === "demo",
      setActionCompleted: function (x) { actionCompleted.set(x); },
    };
  },

  verifiedEmailsForCredential: function () {
    return _.pluck(SandstormDb.getVerifiedEmailsForCredential(this), "email");
  },
});

GENDERS = { male: "male", female: "female", neutral: "neutral", robot: "robot" };

Template._accountProfileEditor.helpers({
  profile: function () {
    const user = Meteor.user();
    SandstormDb.fillInPictureUrl(user);
    return user.profile;
  },

  isPaymentsEnabled: function () {
    return !!Meteor.settings.public.stripePublicKey;
  },

  isNeutral(pronoun) {
    return pronoun === "neutral" || !(pronoun in GENDERS);
  },

  isMale(pronoun) { return pronoun === "male"; },

  isFemale(pronoun) { return pronoun === "female"; },

  isRobot(pronoun) { return pronoun === "robot"; },

  profileSaved: function () {
    return Meteor.user() && Meteor.user().hasCompletedSignup &&
      Template.instance()._profileSaved.get();
  },

  hasCompletedSignup: function () {
    const user = Meteor.user();
    return user && user.hasCompletedSignup;
  },
});

Template.sandstormAccountSettings.events({
  "click button.link-new-credential": function (ev, instance) {
    instance._isLinkingNewCredential.set(true);
  },

  "click button.cancel-link-new-credential": function (ev, instance) {
    instance._isLinkingNewCredential.set(false);
  },

  "click button.logout-other-sessions": function (ev, instance) {
    instance._logoutOtherSessionsInFlight.set(true);
    Meteor.logoutOtherClients(function (err) {
      if (err) {
        instance._logoutOtherSessionsInFlight.set(false);
        instance._actionCompleted.set({ error: err });
      } else {
        Meteor.call("logoutCredentialsOfCurrentAccount", function (err) {
          instance._logoutOtherSessionsInFlight.set(false);
          if (err) {
            instance._actionCompleted.set({ error: err });
          } else {
            instance._actionCompleted.set({ success: "logged out other sessions" });
          }
        });
      }
    });
  },

  "click button.delete-account": function (ev, instance) {
    instance._showDeletePopup.set(true);
    instance._deleteError.set(null);
    instance._deleteConfirmed.set(false);
  },

  "click button.cancel-delete-account": function (ev, instance) {
    instance._showDeletePopup.set(false);
  },

  "click button.delete-account-real": function (ev, instance) {
    instance._deleteSubmitting.set(true);
    Meteor.call("deleteOwnAccount", instance.find(".feedback").value, function (err) {
      if (err) {
        instance._deleteError.set(err.message);
      } else {
        // User will be logged out automatically, so no need to display anything.
      }
    });
  },

  "click button.make-primary": function (ev, instance) {
    Meteor.call("setPrimaryEmail", ev.target.getAttribute("data-email"));
  },

  "input input.confirm": function (evt, instance) {
    if (evt.currentTarget.value.toLowerCase() === "delete my account") {
      instance._deleteConfirmed.set(true);
    } else {
      instance._deleteConfirmed.set(false);
    }
  },
});

Template.sandstormAccountsFirstSignIn.onCreated(function () {
  this.result = new ReactiveVar(undefined);
  this.autorun(() => {
    const data = Template.currentData();
    check(data, SandstormAccountSettingsUi);
  });
});

Template.sandstormAccountsFirstSignIn.helpers({
  success() {
    const instance = Template.instance();
    const result = instance.result.get();
    return result && result.success;
  },

  error() {
    const instance = Template.instance();
    const result = instance.result.get();
    return result && result.error;
  },

  credentialToConfirm() {
    const credentialId = SandstormDb.getUserCredentialIds(Meteor.user())[0];
    const credential = Meteor.users.findOne({ _id: credentialId });
    if (credential) {
      credential.intrinsicName = SandstormDb.getIntrinsicName(credential, true);
      credential.serviceName = SandstormDb.getServiceName(credential);
      return credential;
    }
  },

  termsAndPrivacy() {
    const result = {
      termsUrl: Template.currentData()._db.getSetting("termsUrl"),
      privacyUrl: Template.currentData()._db.getSetting("privacyUrl"),
    };
    if (result.termsUrl || result.privacyUrl) {
      return result;
    } else {
      return undefined;
    }
  },

  onActionCompleted() {
    const instance = Template.instance();
    return (result) => {
      instance.result.set(result);
    };
  },
});

const submitProfileForm = function (form, cb) {
  if (form.agreedToTerms && !form.agreedToTerms.checked) {
    alert("You must agree to the terms to continue.");
    return;
  }

  const newProfile = {
    name: form.nameInput.value,
    handle: form.handle.value,
    pronoun: form.pronoun.value,
  };

  if (!newProfile.name) {
    alert("You must enter a name.");
    return;
  }

  if (!newProfile.handle.match(/^[a-z_][a-z0-9_]*$/)) {
    // TODO(soon): Reject bad keystrokes in real-time.
    alert("Invalid handle. Handles must contain only English letters, digits, and " +
          "underscores, and must not start with a digit.");
    return;
  }

  Meteor.call("updateProfile", null, newProfile, function (err) {
    if (err) {
      alert("Error updating profile: " + err.message);
    } else if (cb) {
      cb();
    }
  });

  // Stop here unless payments are enabled.
  if (Meteor.settings.public.stripePublicKey) {
    // Pass off to payments module.
    BlackrockPayments.processOptins(form);
  }
};

Template.accountSuspended.helpers({
  timeUntilDeletion: function () {
    return formatFutureTime(Meteor.user().suspended.timestamp.getTime()
      + ACCOUNT_DELETION_SUSPENSION_TIME - new Date());
  },
});

Template.accountSuspended.events({
  "click button.restore-account": function () {
    Meteor.call("unsuspendOwnAccount", function (err) {
      if (err) {
        console.error(err);
        alert(err); // TDOO(someday): better error handling
      }
    });
  },

  "click button.logout": function () {
    Meteor.logout();
  },
});

Template._accountProfileEditor.onCreated(function () {
  this.submitProfileForm = submitProfileForm; // Stored on the object so setup wizard can call it directly.
  this._profileSaved = new ReactiveVar(true);
  this._uploadToken = undefined;
  this._setActionCompleted = this.data.setActionCompleted || function () {};

  this.doUploadIfReady = () => {
    const input = this.find("input[name='picture']");
    const file = input && input.files && input.files[0];
    const token = this._uploadToken;
    if (token && file) {
      // Clear the file input and the upload token, so we won't accidentally trigger again
      // if the user clicks the button or changes the input.
      input.value = "";
      this._uploadToken = undefined;
      // Perform the upload.
      this.doUpload(token, file);
    }
  };

  this.doUpload = (token, file) => {
    const staticHost = this.data.staticHost;
    if (!staticHost) throw new Error("missing staticHost");
    const path = staticHost + "/" + token;
    HTTP.post(path, { content: file, }, (err, result) => {
      if (err) {
        this._setActionCompleted({ error: "Upload failed: " + err.message });
      } else if (result.statusCode >= 400) {
        this._setActionCompleted({ error: "Upload failed: " + result.statusCode + " " + result.content });
      } else {
        this._setActionCompleted({ success: "picture updated" });
      }
    });
  };
});

Template._accountProfileEditor.events({
  "submit form.account-profile-editor": function (evt, instance) {
    evt.preventDefault();
    const form = Template.instance().find("form");
    submitProfileForm(form, function () {
      instance._profileSaved.set(true);
      instance._setActionCompleted({ success: "profile saved" });
    });
  },

  "change"(evt, instance) {
    // Pictures get saved right away.
    //
    // TODO(someday): Upload pictures to a staging area, perhaps allowing the user to resize
    //   and crop them before saving.
    if (evt.target === instance.find("input[name='picture']")) { return; }

    instance._profileSaved.set(false);
  },

  "change input[name='picture']"(evt, instance) {
    instance.doUploadIfReady();
  },

  "input input"() { Template.instance()._profileSaved.set(false); },

  "keypress input"() { Template.instance()._profileSaved.set(false); },

  "click .logout": function (evt, instance) {
    evt.preventDefault();
    Meteor.logout();
  },

  "click button[name=upload-picture]": function (evt, instance) {
    const input = instance.find("input[name='picture']");
    // Clear any file that was already selected.
    input.value = "";

    // Request an upload token from the server.
    Meteor.call("uploadProfilePicture", (err, result) => {
      if (err) {
        instance._setActionCompleted({ error: "Upload rejected: " + err.message });
      } else {
        instance._uploadToken = result;
        instance.doUploadIfReady();
      }
    });

    // Open the file picker.
    input.click();
  },
});
