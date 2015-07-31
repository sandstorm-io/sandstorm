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

var identiconCache = {};

function makeIdenticon(service, id) {
  // In Github's case, we hash the id bare because our identicon algorithm then produces exactly
  // the same icon as Github itself would produce. For other services, we add a prefix to prevent
  // accidental collisions. (Github's IDs are strictly numeric, so any non-numeric prefix cannot
  // collide.)
  if (service !== "github") {
    id = service + ":" + id;
  }

  if (id in identiconCache) {
    return identiconCache[id];
  }

  // Unfortunately, Github's algorithm uses MD5. Whatever, we don't expect these to be secure.
  var hash = CryptoJS.MD5(id.toString()).toString();
  var data = new Identicon(hash, 128).toString();
  var result = "data:image/png;base64," + data;
  identiconCache[id] = result;
  return result;
}

function staticAssetUrl(id, staticHost) {
  if (id) {
    return staticHost + "/" + id;
  } else {
    return undefined;
  }
}

function filterHandle(handle) {
  // Convert disallowed letters into underscores, but no more than one underscore in a row.
  return handle && handle.toLowerCase().split(/[^a-z0-9_]+/g).join("_");
}

function emailToHandle(email) {
  // Turn an email address into a handle.

  if (!email) return undefined;

  // Use the stuff before the @. Ignore stuff after '+' because it's commonly used for filters
  // on the same account.
  var parts = email.split("@");
  var base = filterHandle(parts[0].split("+")[0]);

  var domain = (parts[1]||"").split(".");
  if (domain[domain.length - 1] === "name") {
    // Oh, a .name domain. Let's use
    base = filterHandle(domain.slice(0, domain.length - 1).join("."));
  } else if (_.contains(["me", "self", "contact", "admin", "administrator", "root", "info",
                         "sandstorm", "sandstormio", "inbox", "indiegogo", "mail", "email"],
                         base)) {
    // This is probably an address at a vanity domain. Use the domain itself as the handle.
    base = filterHandle(domain[0]);
  }

  return filterHandle(base);
}

function googleIdentity(user, staticHost) {
  var google = (user.services && user.services.google) || {};
  var profile = user.profile || {};

  return {
    id: "google",
    name: profile.name || google.name || "Name Unknown",
    handle: profile.handle || emailToHandle(google.email) ||
            filterHandle(profile.name || google.name) || "unknown",
    picture: staticAssetUrl(profile.picture, staticHost) || makeIdenticon("google", google.id),
    pronoun: profile.pronoun || GENDERS[google.gender] || "neutral",
  }
}

function githubIdentity(user, staticHost) {
  var github = (user.services && user.services.github) || {};
  var profile = user.profile || {};

  return {
    id: "github",
    name: profile.name || "Name Unknown",
    handle: profile.handle || filterHandle(github.username) ||
            filterHandle(profile.name) || "unknown",
    picture: staticAssetUrl(profile.picture, staticHost) || makeIdenticon("github", github.id),
    pronoun: profile.pronoun,
  }
}

function emailIdentity(user, staticHost) {
  var email = (user.services && user.services.emailToken) || {};
  var profile = user.profile || {};

  return {
    id: "email",
    name: profile.name || "Name Unknown",
    handle: profile.handle || emailToHandle(email.email) ||
            filterHandle(profile.name) || "unknown",
    picture: staticAssetUrl(profile.picture, staticHost) || makeIdenticon("email", email.email),
    pronoun: profile.pronoun,
  }
}

function devIdentity(user, staticHost) {
  var email = (user.services && user.services.emailToken) || {};
  var profile = user.profile || {};
  var name = user.devName.split(" ")[0].toLowerCase();

  return {
    id: "dev",
    name: profile.name || user.devName,
    handle: profile.handle || filterHandle(name),
    picture: staticAssetUrl(profile.picture, staticHost) || makeIdenticon("dev", user.devName),
    pronoun: profile.pronoun ||
             (_.contains(["alice", "carol", "eve"], name) ? "female" :
              _.contains(["bob", "dave"], name) ? "male" : "neutral"),
  }
}

function demoIdentity(user, staticHost) {
  var email = (user.services && user.services.emailToken) || {};
  var profile = user.profile || {};

  return {
    id: "dev",
    name: profile.name || "Demo User",
    handle: profile.handle || "demo",
    picture: staticAssetUrl(profile.picture, staticHost) || makeIdenticon("dev", user._id),
    pronoun: profile.pronoun || "neutral",
  }
}

Template.sandstormAccountSettings.helpers({
  identities: function () {
    var staticHost = Template.instance().data._staticHost;

    var user = Meteor.user();
    var result = [];
    if (user && user.services) {
      if ("google" in user.services) {
        result.push(googleIdentity(user, staticHost));
      }
      if ("github" in user.services) {
        result.push(githubIdentity(user, staticHost));
      }
      if ("emailToken" in user.services) {
        result.push(emailIdentity(user, staticHost));
      }
      if ("devName" in user) {
        result.push(devIdentity(user, staticHost));
      }
      if ("expires" in user) {
        result.push(demoIdentity(user, staticHost));
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
