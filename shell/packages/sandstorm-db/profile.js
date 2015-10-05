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

var makeIdenticon;
var httpProtocol;
var sha256;

if (Meteor.isServer) {
  Meteor.publish("accountIdentities", function () {
    if (!Meteor.userId) return [];

    return [
      Meteor.users.find(Meteor.userId,
        {fields: {
          "identities":1,
          "devName":1,
          "expires":1,

          "services.google.id":1,
          "services.google.email":1,
          "services.google.verified_email":1,
          "services.google.name":1,
          "services.google.picture":1,
          "services.google.gender":1,

          "services.github.id":1,
          "services.github.email":1,
          "services.github.username":1,

          "services.emailToken.email":1
        }})
    ];
  });

  makeIdenticon = function (id) {
    // We only make identicons client-side.
    return undefined;
  }

  var Url = Npm.require("url");
  httpProtocol = Url.parse(process.env.ROOT_URL).protocol;

  var Crypto = Npm.require("crypto");
  sha256 = function (data) {
    return Crypto.createHash("sha256").update(data).digest("hex");
  };
} else {
  var identiconCache = {};

  makeIdenticon = function (id) {
    // Given a cryptographic hash as input, generate an identicon. We always use the user's
    // identity ID as the input hash (the same thing passed to apps as the user ID).

    // Pass to identicon.js exactly the hash that we'd pass to apps as X-Sandstorm-User-Id, so
    // that apps can themselves use identicon.js to produce consistent identicons. As it turns out
    // identicon.js doesn't use the second half of the hash even if we provide it, but slice it
    // anyway to be safe.
    id = id.slice(0, 32);

    if (id in identiconCache) {
      return identiconCache[id];
    }

    // Unfortunately, Github's algorithm uses MD5. Whatever, we don't expect these to be secure.
    var data = new Identicon(id, 512).toString();
    var result = "data:image/png;base64," + data;
    identiconCache[id] = result;
    return result;
  }

  httpProtocol = window.location.protocol;

  sha256 = function (data) {
    return CryptoJS.SHA256(data).toString();
  };
}

var GENDERS = {male: "male", female: "female", neutral: "neutral", robot: "robot"};

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

SandstormDb.getVerifiedEmails = function (user) {
  var result = [];

  var services = user.services || {};
  var google = services.google || {};
  if (google.email && google.verified_email) result.push(google.email);
  if (services.emailToken) result.push(services.emailToken.email);

  // TODO(soon): Verification of email addresses -- perhaps through asking the user to log in as
  //   the given identity?

  return result;
}

function fillInDefaults(identity, user) {
  if (identity.service === "github") {
    identity.name = identity.name || user.services.github.username || "Name Unknown";
    identity.handle = identity.handle || filterHandle(user.services.github.username) ||
        filterHandle(identity.name) || "unknown";
  } else if (identity.service === "google") {
    identity.name = identity.name || user.services.google.name || "Name Unknown";
    identity.handle = identity.handle || emailToHandle(user.services.google.email) ||
        filterHandle(identity.name) || "unknown";
    identity.pronoun = identity.pronoun || GENDERS[user.services.google.gender] || "neutral";
  } else if (identity.service === "emailToken") {
    identity.name = identity.name || user.services.emailToken.email.split("@")[0] || "Name Unknown";
    identity.handle = identity.handle || emailToHandle(user.services.emailToken.email) ||
        filterHandle(identity.name) || "unknown";
  } else if (identity.service === "dev") {
    var lowerCaseName = user.devName.split(" ")[0].toLowerCase();
    identity.name = identity.name || user.devName;
    identity.handle = identity.handle || filterHandle(lowerCaseName);
    identity.pronoun = identity.pronoun ||
        (_.contains(["alice", "carol", "eve"], lowerCaseName) ? "female" :
         _.contains(["bob", "dave"], lowerCaseName) ? "male" : "neutral");
  } else if (identity.service === "demo") {
    identity.name = identity.name || "Demo User";
    identity.handle = identity.handle || "demo";
  } else {
    throw new Error("unrecognized identity service: " + identity.service);
  }

  identity.pronoun = identity.pronoun || "netural";
}

SandstormDb.getUserIdentities = function (user) {
  // Given a user object, return all of the user's identities.
  //
  // On the client, must be subscribed "accountIdentities" for the user.
  if (!user) return [];

  var staticHost = httpProtocol + "//" + makeWildcardHost("static");
  return user.identities.map(function(identity) {
    identity.pictureUrl = staticAssetUrl(identity.picture, staticHost) || makeIdenticon(identity.id);
    fillInDefaults(identity, user);
    return identity;
  });
}
