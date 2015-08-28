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
  this.subscribe("accountIdentities");
  this._profileSaved = new ReactiveVar(true);
});

GENDERS = {male: "male", female: "female", neutral: "neutral", robot: "robot"};

var helpers = {
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

  profileSaved: function () {
    return Template.instance()._profileSaved.get();
  },

  db: function () {
    return Template.instance().data._db;
  }
};

Template.sandstormAccountSettings.helpers(helpers);
Template._accountProfileEditor.helpers(helpers);

Template.sandstormAccountsFirstSignIn.onCreated(function () {
  this.subscribe("accountIdentities");
});

Template.sandstormAccountsFirstSignIn.helpers({
  mainIdentity: function () {
    return SandstormDb.getUserIdentities(Meteor.user())[0];
  },
  termsAndPrivacy: function () {
    var result = {
      termsUrl: Template.instance().data._db.getSetting("termsUrl"),
      privacyUrl: Template.instance().data._db.getSetting("privacyUrl"),
    };
    if (result.termsUrl || result.privacyUrl) {
      return result;
    } else {
      return undefined;
    }
  }
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
    email: form.email.value,
  };

  if (!newProfile.name) {
    alert("You must enter a name.");
    return;
  }
  if (!newProfile.email) {
    alert("You must enter an email.");
    return;
  }

  if (!newProfile.handle.match(/^[a-z_][a-z0-9_]*$/)) {
    // TODO(soon): Reject bad keystrokes in real-time.
    alert("Invalid handle. Handles must contain only English letters, digits, and " +
          "underscores, and must not start with a digit.");
    return;
  }

  Meteor.call("updateProfile", newProfile, function (err) {
    if (err) {
      alert("Error updating profile: " + err.message);
    } else if (cb) {
      console.log(cb);
      cb();
    }
  });
}

Template.sandstormAccountSettings.events({
  "submit form.account-profile-editor": function (event, instance) {
    submitProfileForm(event, function () {
      instance._profileSaved.set(true);
    });
  },
  "change": function () { Template.instance()._profileSaved.set(false); },
  "input input": function () { Template.instance()._profileSaved.set(false); },
  "keypress": function () { Template.instance()._profileSaved.set(false); },
});

Template.sandstormAccountsFirstSignIn.events({
  "submit form": function (event) {
    submitProfileForm(event);
  }
});

Template._accountProfileEditor.events({
  "click .picture button": function (event) {
    event.preventDefault();

    var staticHost = Template.parentData(1)._staticHost;
    if (!staticHost) throw new Error("missing _staticHost");

    // TODO(cleanup): Share code with "restore backup" and other upload buttons.
    var input = document.createElement("input");
    input.type = "file";
    input.style = "display: none";

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

    Meteor.call("uploadProfilePicture", function (err, result) {
      if (err) {
        alert("Upload rejected: " + err.message);
      } else {
        token = result;
        if (file && token) doUpload();
      }
    });

    input.addEventListener("change", function (event) {
      file = event.currentTarget.files[0];
      if (file && token) doUpload();
    });

    // IE wants the input element to be in the DOM, but only during the click() call.
    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  }
});
