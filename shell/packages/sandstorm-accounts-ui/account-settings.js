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

SandstormAccountSettingsUi = function (topbar, staticHost) {
  this._topbar = topbar;
  this._staticHost = staticHost;
  this._editing = new ReactiveVar(null);
}

Template.sandstormAccountSettings.onCreated(function () {
  this.subscribe("accountIdentities");
});

GENDERS = {male: "male", female: "female", neutral: "neutral", robot: "robot"};

Template.sandstormAccountSettings.helpers({
  identities: function () {
    return SandstormDb.getUserIdentities(Meteor.user());
  },

  editing: function () {
    return Template.instance().data._editing.get() === this.id;
  },

  isNeutral: function () {
    return this.pronoun === "neutral" || !(this.pronoun in GENDERS);
  },
  isMale: function () { return this.pronoun === "male"; },
  isFemale: function () { return this.pronoun === "female"; },
  isRobot: function () { return this.pronoun === "robot"; },
});

Template.sandstormAccountSettings.events({
  "click .identities>.display>ul>.edit>button": function (event) {
    Template.instance().data._editing.set(this.id);
  },
  "click .identities>.edit .picture button": function (event) {
    event.preventDefault();

    var staticHost = Template.instance().data._staticHost;

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

    input.click();
  },
  "click .identities>.add button": function (event) {
    event.preventDefault();
    alert("Multiple identities not implemented yet. :(");
  },
  "click .identities>.edit>form>ul>.save>.cancel": function (event) {
    event.preventDefault();
    Template.instance().data._editing.set(null);
  },
  "submit .identities>.edit>form": function (event) {
    event.preventDefault();
    var form = Template.instance().find("form");

    var newProfile = {
      name: form.nameInput.value,
      handle: form.handle.value,
      // picture: form.picture.value,  // TODO(now)
      pronoun: form.pronoun.value,
    };

    if (!newProfile.handle.match(/^[a-z_][a-z0-9_]*$/)) {
      // TODO(soon): Reject bad keystrokes in real-time.
      alert("Invalid handle. Handles must contain only English letters, digits, and " +
            "underscores, and must not start with a digit.");
      return;
    }

    Template.instance().data._editing.set(null);
    Meteor.call("updateProfile", newProfile, function (err) {
      if (err) alert("Error updating profile: " + err.message);
    });
  }
});
