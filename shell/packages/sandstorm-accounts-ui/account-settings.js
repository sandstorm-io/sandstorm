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
}

Template.sandstormAccountSettings.onCreated(function () {
  this._isLinkingNewIdentity = new ReactiveVar(false);
  this._selectedIdentityId = new ReactiveVar(null);

  var self = this;
  this.resetSelectedIdentity = function() {
    var identity = SandstormDb.getUserIdentities(Meteor.user())[0];
    if (identity) {
      self._selectedIdentityId.set(identity._id);
    }
  }

  this.subscribe("accountIdentities", {onReady: this.resetSelectedIdentity});
});

GENDERS = {male: "male", female: "female", neutral: "neutral", robot: "robot"};

var helpers = {
  setDocumentTitle: function () {
    document.title = "Account settings · Sandstorm";
  },
  identities: function () {
    return SandstormDb.getUserIdentities(Meteor.user());
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

  isAccountUser: function() {
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
  isIdentitySelected: function(id) {
    return Template.instance()._selectedIdentityId.get() === id;
  },
  isIdentityHidden: function(id) {
    return Template.instance()._selectedIdentityId.get() != id;
  },
  isLinkingNewIdentity: function() {
    return Template.instance()._isLinkingNewIdentity.get()
  },
  verifiedEmails: function () {
    return Meteor.user() && SandstormDb.getUserEmails(Meteor.user())
      .filter(function (e) { return !!e.verified; });
  },
  needsVerifiedEmail: function () {
    return Meteor.user() && SandstormDb.getUserEmails(Meteor.user())
      .filter(function (e) { return !!e.verified; }).length == 0;
  },
});

Template._accountProfileEditor.helpers({
  hasCompletedSignup: function () {
    var user = Meteor.user();
    return user && user.hasCompletedSignup;
  },
  termsAndPrivacy: function () {
    var result = {
      termsUrl: Template.parentData(1)._db.getSetting("termsUrl"),
      privacyUrl: Template.parentData(1)._db.getSetting("privacyUrl"),
    };
    if (result.termsUrl || result.privacyUrl) {
      return result;
    } else {
      return undefined;
    }
  },
});

Template.sandstormAccountSettings.events({
  "click [role='tab']": function(event, instance) {
    instance._selectedIdentityId.set(event.currentTarget.getAttribute("data-identity-id"));
  },
  "click button.link-new-identity": function(event, instance) {
    instance._isLinkingNewIdentity.set(true);
  },
  "click button.cancel-link-new-identity": function(event, instance) {
    instance._isLinkingNewIdentity.set(false);
  },

  "click button.logout-other-sessions": function() {
    Meteor.logoutOtherClients(function(err) {
      if (err) {
        console.log("Error logging out other clients: ", err);
      }
    });
    Meteor.call("logoutIdentitiesOfCurrentAccount", function(err) {
      if (err) {
        console.log("Error logging out identities: ", err);
      }
    });
  },

  "click button.unlink-identity": function (event, instance) {
    var identityId = event.target.getAttribute("data-identity-id");
    Meteor.call("unlinkIdentity", Meteor.userId(), identityId, function (err, result) {
      if (err) {
        console.log("err: ", err);
      } else {
        instance.resetSelectedIdentity();
      }
    });
  },

  "click button.make-login": function (event, instance) {
    var identityId = event.target.getAttribute("data-identity-id");
    Meteor.call("setIdentityAllowsLogin", identityId, true, function (err, result) {
      if (err) {
        console.log("err: ", err);
      }
    });
  },

  "click button.make-no-login": function (event, instance) {
    var identityId = event.target.getAttribute("data-identity-id");
    Meteor.call("setIdentityAllowsLogin", identityId, false, function (err, result) {
      if (err) {
        console.log("err: ", err);
      }
    });
  },

  "change input.primary-email": function (event, instance) {
    Meteor.call("setPrimaryEmail", event.target.getAttribute("data-email"));
  },
});


Template.sandstormAccountsFirstSignIn.helpers({
  identityToConfirm: function () {
    return SandstormDb.getUserIdentities(Meteor.user())[0];
  },
});

var submitProfileForm = function (event, cb) {
  event.preventDefault();
  var form = Template.instance().find("form");

  if (form.agreedToTerms && !form.agreedToTerms.checked) {
    alert("You must agree to the terms to continue.");
    return;
  }

  var newProfile = {
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
  var identityId = form.getAttribute("data-identity-id");

  Meteor.call("updateProfile", identityId, newProfile, function (err) {
    if (err) {
      alert("Error updating profile: " + err.message);
    } else if (cb) {
      cb();
    }
  });
}

Template._accountProfileEditor.events({
  "submit form.account-profile-editor": function (event, instance) {
    submitProfileForm(event, function () {
      instance._profileSaved.set(true);
    });
  },
  "change": function (event, instance) {
    // Pictures get saved right away.
    //
    // TODO(someday): Upload pictures to a staging area, perhaps allowing the user to resize
    //   and crop them before saving.
    if (event.target == instance.find("input[name='picture']")) { return; }

    instance._profileSaved.set(false);
  },
  "input input": function () { Template.instance()._profileSaved.set(false); },
  "keypress": function () { Template.instance()._profileSaved.set(false); },

  "click .logout": function (event, instance) {
    event.preventDefault();
    Meteor.logout();
  }
});

Template._accountProfileEditor.onCreated(function () {
  this._profileSaved = new ReactiveVar(true);
});

Template._accountProfileEditor.events({
  "click .picture button": function (event, instance) {
    event.preventDefault();

    var staticHost = Template.parentData(1)._staticHost;
    if (!staticHost) throw new Error("missing _staticHost");

    // TODO(cleanup): Share code with "restore backup" and other upload buttons.
    var input = instance.find("input[name='picture']");

    var file = undefined;
    var token = undefined;

    var doUpload = function () {
      HTTP.post(staticHost + "/" + token, { content: file, }, function (err, result) {
        if (err) {
          alert("Upload failed: " + err.message);
        } else if (result.statusCode >= 400) {
          alert("Upload failed: " + result.statusCode + " " + result.content);
        }
      });
    }

    Meteor.call("uploadProfilePicture", instance.data._id, function (err, result) {
      if (err) {
        alert("Upload rejected: " + err.message);
      } else {
        token = result;
        if (file && token) doUpload();
      }
    });

    function listener(event) {
      input.removeEventListener("change", listener);
      file = event.currentTarget.files[0];
      if (file && token) doUpload();
    }
    input.addEventListener("change", listener);
    input.click();
  }
});
