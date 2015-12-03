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

if (Meteor.isServer) {
  SandstormDb.ensureSubscriberHasIdentity = function(publishHandler, identityId) {
    // Helper for publish functions that need to restrict access based on whether the subscriber
    // has a given identity linked. Automatically stops the subscription if the user loses the
    // identity. Returns a boolean indicating whether the user initially has the identity.

    var userId = publishHandler.userId;
    if (userId === identityId) {
      return true;
    } else {
      var hasIdentityCursor =
          Meteor.users.find({$or: [{_id: userId, "loginIdentities.id": identityId},
                                   {_id: userId, "nonloginIdentities.id": identityId}]});
      if (hasIdentityCursor.count() == 0) {
        publishHandler.stop();
        return false;
      }
      var handle = hasIdentityCursor.observe({removed: function () { publishHandler.stop(); }});
      publishHandler.onStop(function () { handle.stop(); });
      return true;
    }
  }

  Meteor.publish("identityProfile", function (identityId) {
    check(identityId, String);
    if (!SandstormDb.ensureSubscriberHasIdentity(this, identityId)) return;

    return Meteor.users.find({_id: identityId},
      {fields: {
        "profile":1,
        "unverifiedEmail":1,
        "expires": 1,

        "services.dev.name":1,

        "services.google.id":1,
        "services.google.email":1,
        "services.google.verified_email":1,
        "services.google.name":1,
        "services.google.picture":1,
        "services.google.gender":1,

        "services.github.id":1,
        "services.github.email":1,
        "services.github.emails":1,
        "services.github.username":1,

        "services.email.email":1,
      }});
  }),

  Meteor.publish("accountIdentities", function () {
    // Maybe this should be folded into the "credentials" subscription?

    if (!this.userId) return [];

    return Meteor.users.find(
      {_id: this.userId},
      {fields: {
        "profile": 1,
        "verifiedEmail": 1,
        "loginIdentities": 1,
        "nonloginIdentities": 1,
        "expires": 1,
        "primaryEmail": 1,
      }});
  });

  makeIdenticon = function (id) {
    // We only make identicons client-side.
    return undefined;
  }

  var Url = Npm.require("url");
  httpProtocol = Url.parse(process.env.ROOT_URL).protocol;
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

SandstormDb.fillInProfileDefaults = function(user) {
  var profile = user.profile;
  if (profile.service === "github") {
    profile.name = profile.name || user.services.github.username || "Name Unknown";
    profile.handle = profile.handle || filterHandle(user.services.github.username) ||
        filterHandle(profile.name);
  } else if (profile.service === "google") {
    profile.name = profile.name || user.services.google.name || "Name Unknown";
    profile.handle = profile.handle || emailToHandle(user.services.google.email) ||
        filterHandle(profile.name);
    profile.pronoun = profile.pronoun || GENDERS[user.services.google.gender] || "neutral";
  } else if (profile.service === "email") {
    var email = user.services.email.email
    profile.name = profile.name || email.split("@")[0];
    profile.handle = profile.handle || emailToHandle(email);
  } else if (profile.service === "dev") {
    var lowerCaseName = user.services.dev.name.split(" ")[0].toLowerCase();
    profile.name = profile.name || user.services.dev.name;
    profile.handle = profile.handle || filterHandle(lowerCaseName);
    profile.pronoun = profile.pronoun ||
        (_.contains(["alice", "carol", "eve"], lowerCaseName) ? "female" :
         _.contains(["bob", "dave"], lowerCaseName) ? "male" : "neutral");
  } else if (profile.service === "demo") {
    profile.name = profile.name || "Demo User";
    profile.handle = profile.handle || "demo";
  } else {
    throw new Error("unrecognized identity service: ", profile.service);
  }

  profile.pronoun = profile.pronoun || "neutral";
}

SandstormDb.fillInIntrinsicName = function(user) {
  var profile = user.profile;
  if (profile.service === "github") {
    profile.intrinsicName = user.services.github.username;
  } else if (profile.service === "google") {
    profile.intrinsicName = user.services.google.name;
    user.privateIntrinsicName = user.services.google.email;
  } else if (profile.service === "email") {
    profile.intrinsicName = user.services.email.email
  } else if (profile.service === "dev") {
    profile.intrinsicName = user.services.dev.name;
  } else if (profile.service === "demo") {
    // No intrinsic name.
  } else {
    throw new Error("unrecognized identity service: ", profile.service);
  }
}

SandstormDb.getVerifiedEmails = function(identity) {
  if (identity.services.google && identity.services.google.email &&
      identity.services.google.verified_email) {
    return [identity.services.google.email];
  } else if (identity.services.email) {
    return [identity.services.email.email];
  } else if (identity.services.github && identity.services.github.emails) {
    return _.pluck(_.filter(identity.services.github.emails,
                            function(email) { return email.verified; }),
                   "email");
  }
  return [];
}

SandstormDb.fillInPictureUrl = function(user) {
  var staticHost = httpProtocol + "//" + makeWildcardHost("static");
  user.profile.pictureUrl = staticAssetUrl(user.profile.picture, staticHost) ||
    makeIdenticon(user._id);
}

SandstormDb.getUserIdentityIds = function (user) {
  // Given an account user object, returns an array containing the ID of each identity linked to the
  // account. Always returns the most recently added login identity first.
  if (user && user.loginIdentities) {
    return _.pluck(user.nonloginIdentities.concat(user.loginIdentities), "id").reverse();
  } else {
    return [];
  }
};

SandstormDb.getUserEmails = function (user) {
  // Given a user object, returns an array containing all email addresses associated with that user.
  // Each entry in the array is an object of the form:
  //     `{email: String, verified: Bool, primary: Optional(Bool)}`
  //
  // At most one entry in the result has `primary = true`.
  //
  // TODO(cleanup): This actually does need to query the database to fetch profile information
  //   for linked identities, so it probably makes more sense for it to be a non-static method
  //   on SandstormDb.

  var identityIds = SandstormDb.getUserIdentityIds(user);
  verifiedEmails = {};
  unverifiedEmails = {};

  identityIds.forEach(function (id) {
    var identity = Meteor.users.findOne({_id: id});
    if (identity && identity.services) {
      SandstormDb.getVerifiedEmails(identity).forEach(function(verifiedEmail) {
        if (verifiedEmail) {
          verifiedEmails[verifiedEmail] = true;
        }
      });
    }
    if (identity && identity.unverifiedEmail) {
      unverifiedEmails[identity.unverifiedEmail] = true;
    }
  });

  var result = [];
  _.keys(verifiedEmails).map(function (email) {
    result.push({email: email,
                 verified: true,
                 primary: email === user.primaryEmail});
  });
  _.keys(unverifiedEmails).map(function (email) {
    if (!(email in verifiedEmails)) { result.push({email: email, verified: false}) }
  });

  // If `user.primaryEmail` is not among the verified emails, mark the first as primary.
  if (!(user.primaryEmail in verifiedEmails) && result.length > 0) {
    result[0].primary = true;
  }
  return result;
}
