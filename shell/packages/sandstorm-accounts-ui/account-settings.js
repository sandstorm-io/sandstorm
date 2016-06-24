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

SandstormAccountSettingsUi = function (topbar, db, staticHost) {
  this._topbar = topbar;
  this._db = db;
  this._staticHost = staticHost;
};

Template.sandstormAccountSettings.onCreated(function () {
  this._isLinkingNewIdentity = new ReactiveVar(false);
  this._selectedIdentityId = new ReactiveVar();
  this._actionCompleted = new ReactiveVar();
  this._logoutOtherSessionsInFlight = new ReactiveVar(false);
  const _this = this;

  // TODO(cleanup): Figure out a better way to pass in this data. Perhaps it should be part of
  //   the URL?
  let err = Session.get("linkingIdentityError");
  if (err) {
    if (err.alreadyLinked) {
      this._actionCompleted.set(
        { success: "Identity was already linked to this account" });
    } else {
      this._actionCompleted.set(
        { error: "Error linking identity: " + err });
    }

    Session.set("linkingIdentityError");
  }

  this.autorun(function () {
    // Reset the selected identity ID when appropriate.
    const user = Meteor.user();
    if (user && user.loginIdentities) {
      const identities = user.loginIdentities.concat(user.nonloginIdentities);
      const currentlySelected = _this._selectedIdentityId.get();
      if (!currentlySelected || !_.findWhere(identities, { id: currentlySelected })) {
        if (identities.length > 0) {
          _this._selectedIdentityId.set(identities[0].id);
        }
      }
    }
  });
});

GENDERS = { male: "male", female: "female", neutral: "neutral", robot: "robot" };

const helpers = {
  setDocumentTitle: function () {
    document.title = "Account settings · " + Template.instance().data._db.getServerTitle();
  },

  identities: function () {
    return SandstormDb.getUserIdentityIds(Meteor.user()).map(function (id) {
      const identity = Meteor.users.findOne({ _id: id });
      if (identity) {
        SandstormDb.fillInProfileDefaults(identity);
        SandstormDb.fillInIntrinsicName(identity);
        SandstormDb.fillInPictureUrl(identity);
        return identity;
      }
    });
  },

  isNeutral: function () {
    return this.pronoun === "neutral" || !(this.pronoun in GENDERS);
  },

  isMale: function () { return this.pronoun === "male"; },

  isFemale: function () { return this.pronoun === "female"; },

  isRobot: function () { return this.pronoun === "robot"; },

  isPaymentsEnabled: function () {
    try {
      BlackrockPayments; // This checks that BlackrockPayments is defined.
      return true;
    } catch (e) {
      return false;
    }
  },

  isAccountUser: function () {
    return Meteor.user() && !!Meteor.user().loginIdentities;
  },

  profileSaved: function () {
    return Meteor.user() && Meteor.user().hasCompletedSignup &&
      Template.instance()._profileSaved.get();
  },

  db: function () {
    return Template.instance().data._db;
  },

};

Template.sandstormAccountSettings.helpers(helpers);
Template._accountProfileEditor.helpers(helpers);

Template.sandstormAccountSettings.helpers({
  isIdentitySelected: function (id) {
    return Template.instance()._selectedIdentityId.get() === id;
  },

  isIdentityHidden: function (id) {
    return Template.instance()._selectedIdentityId.get() != id;
  },

  isLinkingNewIdentity: function () {
    return Template.instance()._isLinkingNewIdentity.get();
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

  linkingNewIdentityData: function () {
    const instance = Template.instance();
    return {
      doneCallback: function () {
        instance._isLinkingNewIdentity.set(false);
        instance._actionCompleted.set({ success: "identity added" });
      },
    };
  },

  emailLoginFormData: function () {
    const instance = Template.instance();
    return {
      linkingNewIdentity: {
        doneCallback: function () {
          const input = instance.find("input[name='email']");
          if (input) {
            input.value = "";
          };

          instance._actionCompleted.set({ success: "identity added" });
        },
      },
      sendButtonText: "Confirm",
    };
  },

  logoutOtherSessionsInFlight: function () {
    return Template.instance()._logoutOtherSessionsInFlight.get();
  },
});

Template._accountProfileEditor.helpers({
  hasCompletedSignup: function () {
    const user = Meteor.user();
    return user && user.hasCompletedSignup;
  },

  identityManagementButtonsData: function () {
    if (this.identity) {
      const user = Meteor.user();
      const identityId = this.identity._id;
      return {
        _id: identityId,
        isLogin: user.loginIdentities && !!_.findWhere(user.loginIdentities, { id: identityId }),
        isDemo: this.identity.profile.service === "demo",
        setActionCompleted: Template.instance()._setActionCompleted,
      };
    }
  },

  verifiedEmails: function () {
    if (this.identity) {
      return _.pluck(SandstormDb.getVerifiedEmails(this.identity), "email");
    }
  },

  emailDetails: function () {
    if (this.identity) {
      const emails = SandstormDb.getVerifiedEmails(this.identity);
      if (emails.length == 0) {
        return "This identity has no attached e-mail.";
      } else if (emails.length == 1) {
        return "E-mail attached to this identity";
      } else {
        return "E-mails attached to this identity";
      }
    }
  },
});

Template.sandstormAccountSettings.events({
  "click [role='tab']": function (ev, instance) {
    instance._actionCompleted.set();
    instance._selectedIdentityId.set(ev.currentTarget.getAttribute("data-identity-id"));
  },

  "click button.link-new-identity": function (ev, instance) {
    instance._isLinkingNewIdentity.set(true);
  },

  "click button.cancel-link-new-identity": function (ev, instance) {
    instance._isLinkingNewIdentity.set(false);
  },

  "click button.logout-other-sessions": function (ev, instance) {
    instance._logoutOtherSessionsInFlight.set(true);
    Meteor.logoutOtherClients(function (err) {
      if (err) {
        instance._logoutOtherSessionsInFlight.set(false);
        instance._actionCompleted.set({ error: err });
      } else {
        Meteor.call("logoutIdentitiesOfCurrentAccount", function (err) {
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

  "click button.make-primary": function (ev, instance) {
    Meteor.call("setPrimaryEmail", ev.target.getAttribute("data-email"));
  },
});

Template.sandstormAccountsFirstSignIn.helpers({
  identityToConfirm: function () {
    const identityId = SandstormDb.getUserIdentityIds(Meteor.user())[0];
    const identity = Meteor.users.findOne({ _id: identityId });
    if (identity) {
      SandstormDb.fillInProfileDefaults(identity);
      SandstormDb.fillInIntrinsicName(identity);
      SandstormDb.fillInPictureUrl(identity);
      return identity;
    }
  },

  termsAndPrivacy: function () {
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

  const identityId = form.getAttribute("data-identity-id");

  Meteor.call("updateProfile", identityId, newProfile, function (err) {
    if (err) {
      alert("Error updating profile: " + err.message);
    } else if (cb) {
      cb();
    }
  });

  // Stop here unless payments module is loaded.
  try {
    BlackrockPayments;
  } catch (e) {
    return;
  }

  // Pass off to payments module.
  BlackrockPayments.processOptins(form);
};

Template._accountProfileEditor.onCreated(function () {
  this.submitProfileForm = submitProfileForm; // Stored on the object so setup wizard can call it directly.
  this._profileSaved = new ReactiveVar(true);
  this._setActionCompleted = this.data.setActionCompleted || function () {};
});

Template._accountProfileEditor.events({
  "submit form.account-profile-editor": function (ev, instance) {
    ev.preventDefault();
    const form = Template.instance().find("form");
    submitProfileForm(form, function () {
      instance._profileSaved.set(true);
      instance._setActionCompleted({ success: "profile saved" });
    });
  },

  change: function (ev, instance) {
    // Pictures get saved right away.
    //
    // TODO(someday): Upload pictures to a staging area, perhaps allowing the user to resize
    //   and crop them before saving.
    if (ev.target == instance.find("input[name='picture']")) { return; }

    instance._profileSaved.set(false);
  },

  "input input": function () { Template.instance()._profileSaved.set(false); },

  keypress: function () { Template.instance()._profileSaved.set(false); },

  "click .logout": function (ev, instance) {
    ev.preventDefault();
    Meteor.logout();
  },

  "click .picture button": function (ev, instance) {
    ev.preventDefault();

    const staticHost = Template.currentData().staticHost;
    if (!staticHost) throw new Error("missing _staticHost");

    // TODO(cleanup): Share code with "restore backup" and other upload buttons.
    const input = instance.find("input[name='picture']");

    let file = undefined;
    let token = undefined;

    const doUpload = function () {
      HTTP.post(staticHost + "/" + token, { content: file, }, function (err, result) {
        if (err) {
          alert("Upload failed: " + err.message);
        } else if (result.statusCode >= 400) {
          alert("Upload failed: " + result.statusCode + " " + result.content);
        } else {
          instance._setActionCompleted({ success: "picture updated" });
        }
      });
    };

    Meteor.call("uploadProfilePicture", instance.data.identity._id, function (err, result) {
      if (err) {
        alert("Upload rejected: " + err.message);
      } else {
        token = result;
        if (file && token) doUpload();
      }
    });

    function listener(ev) {
      input.removeEventListener("change", listener);
      file = ev.currentTarget.files[0];
      if (file && token) doUpload();
    }

    input.addEventListener("change", listener);
    input.click();
  },
});
