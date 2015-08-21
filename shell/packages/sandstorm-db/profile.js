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
          "profile":1,
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

function identityId(service, id) {
  return sha256(service + ":" + id);
}

function googleIdentity(user, staticHost) {
  var google = (user.services && user.services.google) || {};
  var profile = user.profile || {};
  var id = identityId("google", google.id);

  return {
    service: "google",
    id: id,
    name: profile.name || google.name || "Name Unknown",
    email: profile.email || google.email,
    handle: profile.handle || emailToHandle(google.email) ||
            filterHandle(profile.name || google.name) || "unknown",
    picture: staticAssetUrl(profile.picture, staticHost) || makeIdenticon(id),
    pronoun: profile.pronoun || GENDERS[google.gender] || "neutral",
  }
}

function githubIdentity(user, staticHost) {
  var github = (user.services && user.services.github) || {};
  var profile = user.profile || {};
  var id = identityId("github", github.id);

  return {
    service: "github",
    id: id,
    name: profile.name || github.username || "Name Unknown",
    email: profile.email || github.email,
    handle: profile.handle || filterHandle(github.username) ||
            filterHandle(profile.name) || "unknown",
    picture: staticAssetUrl(profile.picture, staticHost) || makeIdenticon(id),
    pronoun: profile.pronoun,
  }
}

function emailIdentity(user, staticHost) {
  var email = (user.services && user.services.emailToken) || {};
  var profile = user.profile || {};
  var id = identityId("email", email.email);

  return {
    service: "email",
    id: id,
    name: profile.name || email.email.split("@")[0] || "Name Unknown",
    email: profile.email || email.email,
    handle: profile.handle || emailToHandle(email.email) ||
            filterHandle(profile.name) || "unknown",
    picture: staticAssetUrl(profile.picture, staticHost) || makeIdenticon(id),
    pronoun: profile.pronoun,
  }
}

function devIdentity(user, staticHost) {
  var email = (user.services && user.services.emailToken) || {};
  var profile = user.profile || {};
  var name = user.devName.split(" ")[0].toLowerCase();
  var id = identityId("dev", user.devName);

  return {
    service: "dev",
    id: id,
    name: profile.name || user.devName,
    handle: profile.handle || filterHandle(name),
    picture: staticAssetUrl(profile.picture, staticHost) || makeIdenticon(id),
    pronoun: profile.pronoun ||
             (_.contains(["alice", "carol", "eve"], name) ? "female" :
              _.contains(["bob", "dave"], name) ? "male" : "neutral"),
  }
}

function demoIdentity(user, staticHost) {
  var email = (user.services && user.services.emailToken) || {};
  var profile = user.profile || {};
  var id = identityId("demo", user._id);

  return {
    service: "demo",
    id: id,
    name: profile.name || "Demo User",
    handle: profile.handle || "demo",
    picture: staticAssetUrl(profile.picture, staticHost) || makeIdenticon(id),
    pronoun: profile.pronoun || "neutral",
  }
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

SandstormDb.getUserIdentities = function (user) {
  // Given a user object, return all of the user's identities.
  //
  // On the client, must be subscribed "accountIdentities" for the user.

  var staticHost = httpProtocol + "//" + makeWildcardHost("static");

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
}
