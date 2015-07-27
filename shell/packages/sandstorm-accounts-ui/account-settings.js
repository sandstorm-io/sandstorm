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

SandstormAccountSettingsUi = function (topbar) {
  this._topbar = topbar;
  this._editing = new ReactiveVar(null);
}

Template.sandstormAccountSettings.onCreated(function () {
  this.subscribe("accountIdentities");
});

GENDERS = {male: "male", female: "female", neutral: "neutral", robot: "robot"};

var identiconCache = {};

function makeIdenticon(id) {
  if (id in identiconCache) {
    return identiconCache[id];
  }

  var hash = CryptoJS.MD5(id.toString()).toString();
  var data = new Identicon(hash, 64).toString();
  var result = "data:image/png;base64," + data;
  identiconCache[id] = result;
  return result;
}

function googleIdentity(user) {
  var google = (user.services && user.services.google) || {};
  var profile = user.profile || {};

  return {
    id: "google",
    name: profile.name || google.name || "",
    handle: profile.handle || (google.email || "").split("@")[0],
    picture: profile.picture || makeIdenticon(google.id),
    // TODO(now): Download real google avatar.
//    picture: profile.picture || google.picture || "",
    pronoun: profile.pronoun || GENDERS[google.gender] || "neutral",
  }
}

function githubIdentity(user) {
  var github = (user.services && user.services.github) || {};
  var profile = user.profile || {};

  return {
    id: "github",
    name: profile.name || "",
    handle: profile.handle || github.username,
    picture: profile.picture || makeIdenticon(github.id),
    // TODO(now): Download real github avatar.
//    picture: "https://avatars.githubusercontent.com/u/" + github.id + "?v=3"
    pronoun: profile.pronoun,
  }
}

function emailIdentity(user) {
  var email = (user.services && user.services.emailToken) || {};
  var profile = user.profile || {};

  return {
    id: "email",
    name: profile.name || "",
    handle: profile.handle || email.email.split("@")[0],
    picture: profile.picture || makeIdenticon(email.email),
    pronoun: profile.pronoun,
  }
}

Template.sandstormAccountSettings.helpers({
  identities: function () {
    var user = Meteor.user();
    var result = [];
    if (user && user.services) {
      if ("google" in user.services) {
        result.push(googleIdentity(user));
      }
      if ("github" in user.services) {
        result.push(githubIdentity(user));
      }
      if ("emailToken" in user.services) {
        result.push(emailIdentity(user));
      }
    }
    return result;
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
    alert("Setting picture not implemented yet. :(");
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
