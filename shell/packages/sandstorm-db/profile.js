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

let makeIdenticon;
let httpProtocol;

if (Meteor.isServer) {
  SandstormDb.ensureSubscriberHasIdentity = function (publishHandler, identityId) {
    // Helper for publish functions that need to restrict access based on whether the subscriber
    // has a given identity linked. Automatically stops the subscription if the user loses the
    // identity. Returns a boolean indicating whether the user initially has the identity.

    const userId = publishHandler.userId;
    if (userId === identityId) {
      return true;
    } else {
      const hasIdentityCursor = Meteor.users.find({
        $or: [
          {
            _id: userId,
            "loginIdentities.id": identityId,
          },
          {
            _id: userId,
            "nonloginIdentities.id": identityId,
          },
        ],
      });
      if (hasIdentityCursor.count() == 0) {
        publishHandler.stop();
        return false;
      }

      const handle = hasIdentityCursor.observe({ removed: function () { publishHandler.stop(); } });

      publishHandler.onStop(function () { handle.stop(); });

      return true;
    }
  };

  Meteor.publish("identityProfile", function (identityId) {
    check(identityId, String);
    if (!SandstormDb.ensureSubscriberHasIdentity(this, identityId)) return;

    return Meteor.users.find({ _id: identityId },
      { fields: {
        profile: 1,
        unverifiedEmail: 1,
        expires: 1,
        createdAt: 1,

        "services.dev.name": 1,

        "services.google.id": 1,
        "services.google.email": 1,
        "services.google.verified_email": 1,
        "services.google.name": 1,
        "services.google.picture": 1,
        "services.google.gender": 1,
        "services.google.hd": 1,

        "services.github.id": 1,
        "services.github.email": 1,
        "services.github.emails": 1,
        "services.github.username": 1,

        "services.email.email": 1,

        "services.ldap.id": 1,
        "services.ldap.username": 1,
        "services.ldap.rawAttrs": 1,

        "services.saml.id": 1,
        "services.saml.email": 1,
        "services.saml.displayName": 1,
      },
    });
  }),

  Meteor.publish("accountIdentities", function () {
    // Maybe this should be folded into the "credentials" subscription?

    if (!this.userId) return [];

    return Meteor.users.find(
      { _id: this.userId },
      { fields: {
        profile: 1,
        verifiedEmail: 1,
        loginIdentities: 1,
        nonloginIdentities: 1,
        expires: 1,
        primaryEmail: 1,
      }, });
  });

  makeIdenticon = function (id) {
    // We only make identicons client-side.
    return undefined;
  };

  const Url = Npm.require("url");
  httpProtocol = Url.parse(process.env.ROOT_URL).protocol;
} else {
  const identiconCache = {};

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
    const data = new Identicon(id, 512).toString();
    const result = "data:image/svg+xml," + encodeURIComponent(data);
    identiconCache[id] = result;
    return result;
  };

  httpProtocol = window.location.protocol;
}

const GENDERS = { male: "male", female: "female", neutral: "neutral", robot: "robot" };

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
  const parts = email.split("@");
  let base = filterHandle(parts[0].split("+")[0]);

  const domain = (parts[1] || "").split(".");
  if (domain[domain.length - 1] === "name") {
    // Oh, a .name domain. Let's use
    base = filterHandle(domain.slice(0, domain.length - 1).join("."));
  } else if (_.contains(
      [
        "me", "self", "contact", "admin", "administrator", "root", "info",
        "sandstorm", "sandstormio", "inbox", "indiegogo", "mail", "email",
      ],
      base)) {
    // This is probably an address at a vanity domain. Use the domain itself as the handle.
    base = filterHandle(domain[0]);
  }

  return filterHandle(base);
}

SandstormDb.fillInProfileDefaults = function (user) {
  const profile = user.profile;
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
    const email = user.services.email.email;
    profile.name = profile.name || emailToHandle(email);
    profile.handle = profile.handle || emailToHandle(email);
  } else if (profile.service === "dev") {
    const lowerCaseName = user.services.dev.name.split(" ")[0].toLowerCase();
    profile.name = profile.name || user.services.dev.name;
    profile.handle = profile.handle || filterHandle(lowerCaseName);
    profile.pronoun = profile.pronoun ||
        (_.contains(["alice", "carol", "eve"], lowerCaseName) ? "female" :
         _.contains(["bob", "dave"], lowerCaseName) ? "male" : "neutral");
  } else if (profile.service === "demo") {
    profile.name = profile.name || "Demo User";
    profile.handle = profile.handle || "demo";
  } else if (profile.service === "ldap") {
    const setting = Settings.findOne({ _id: "ldapNameField" });
    const key = setting ? setting.value : "";
    profile.handle = profile.handle || user.services.ldap.username;
    profile.name = profile.name || user.services.ldap.rawAttrs[key] || profile.handle;
  } else if (profile.service === "saml") {
    profile.handle = profile.handle || emailToHandle(user.services.saml.email);
    profile.name = profile.name || user.services.saml.displayName || profile.handle;
  } else {
    throw new Error("unrecognized identity service: ", profile.service);
  }

  profile.pronoun = profile.pronoun || "neutral";
};

SandstormDb.fillInIntrinsicName = function (user) {
  const profile = user.profile;
  if (profile.service === "github") {
    profile.intrinsicName = user.services.github.username;
  } else if (profile.service === "google") {
    profile.intrinsicName = user.services.google.name;
    user.privateIntrinsicName = user.services.google.email;
  } else if (profile.service === "email") {
    profile.intrinsicName = user.services.email.email;
  } else if (profile.service === "dev") {
    profile.intrinsicName = user.services.dev.name;
  } else if (profile.service === "demo") {
    profile.intrinsicName = "demo on " + user.createdAt.toISOString().substring(0, 10);
  } else if (profile.service === "ldap") {
    profile.intrinsicName = user.services.ldap.username;
  } else if (profile.service === "saml") {
    profile.intrinsicName = user.services.saml.id;
  } else {
    throw new Error("unrecognized identity service: ", profile.service);
  }
};

SandstormDb.fillInLoginId = function (identity) {
  const service = identity.profile.service;
  identity.loginId = Accounts.identityServices[service].getLoginId(identity);
};

SandstormDb.getVerifiedEmails = function (identity) {
  if (identity.services.google && identity.services.google.email &&
      identity.services.google.verified_email) { // jscs:ignore requireCamelCaseOrUpperCaseIdentifiers
    return [{ email: identity.services.google.email, primary: true }];
  } else if (identity.services.email) {
    return [{ email: identity.services.email.email, primary: true }];
  } else if (identity.services.github && identity.services.github.emails) {
    return _.chain(identity.services.github.emails)
      .filter(function (email) { return email.verified; })
      .map((email) => _.pick(email, "email", "primary"))
      .value();
  } else if (identity.services.ldap) {
    const email = identity.services.ldap.rawAttrs[SandstormDb.prototype.getLdapEmailField()];
    if (email) {
      return [{ email: email, primary: true }];
    }
  } else if (identity.services.saml && identity.services.saml.email) {
    return [{ email: identity.services.saml.email, primary: true }];
  }

  return [];
};

SandstormDb.prototype.findIdentitiesByEmail = function (email) {
  // Returns an array of identities which have the given email address as one of their verified
  // addresses.

  check(email, String);

  return Meteor.users.find({ $or: [
    { "services.google.email": email },
    { "services.email.email": email },
    { "services.github.emails.email": email },
    { "services.saml.email": email },
  ], }).fetch().filter(function (identity) {
    // Verify that the email is verified, since our query doesn't technically do that.
    return !!_findWhere(SandstormDb.getVerifiedEmails(identity), { email: email });
  });
};

SandstormDb.prototype.findAccountsByEmail = function (email) {
  const identityIds = _.pluck(this.findIdentitiesByEmail(email), "_id");
  return Meteor.users.find({ $or: [
    { "loginIdentities.id": { $in: identityIds } },
    { "nonloginIdentities.id": { $in: identityIds } },
  ], }).fetch();
};

SandstormDb.fillInPictureUrl = function (user) {
  const staticHost = httpProtocol + "//" + makeWildcardHost("static");
  user.profile.pictureUrl = staticAssetUrl(user.profile.picture, staticHost) ||
    makeIdenticon(user._id);
};

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

  const identityIds = SandstormDb.getUserIdentityIds(user);
  const verifiedEmails = {};
  const unverifiedEmails = {};

  identityIds.forEach(function (id) {
    const identity = Meteor.users.findOne({ _id: id });
    if (identity && identity.services) {
      SandstormDb.getVerifiedEmails(identity).forEach(function (verifiedEmail) {
        if (verifiedEmail) {
          verifiedEmails[verifiedEmail.email] = true;
        }
      });
    }

    if (identity && identity.unverifiedEmail) {
      unverifiedEmails[identity.unverifiedEmail] = true;
    }
  });

  const result = [];
  _.keys(verifiedEmails).map(function (email) {
    result.push({ email: email,
                  verified: true,
                  primary: email === user.primaryEmail, });
  });

  _.keys(unverifiedEmails).map(function (email) {
    if (!(email in verifiedEmails)) { result.push({ email: email, verified: false }); }
  });

  // If `user.primaryEmail` is not among the verified emails, mark the first as primary.
  if (!(user.primaryEmail in verifiedEmails) && result.length > 0) {
    result[0].primary = true;
  }

  return result;
};

SandstormDb.prototype.addContact = function addContact(ownerId, identityId) {
  check(ownerId, String);
  check(identityId, String);
  const profile = this.getIdentity(identityId).profile;
  this.collections.contacts.upsert({ ownerId: ownerId, identityId: identityId }, {
    ownerId: ownerId,
    petname: profile && profile.name,
    created: new Date(),
    identityId: identityId,
  });
};
