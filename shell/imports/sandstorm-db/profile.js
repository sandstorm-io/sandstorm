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

import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { Accounts } from "meteor/accounts-base";
import { _ } from "meteor/underscore";

import Identicon from "/imports/sandstorm-identicons/identicon";
import { SandstormDb } from "./db";
import { globalDb } from "/imports/db-deprecated";

let makeIdenticon;
let httpProtocol;

if (Meteor.isServer) {
  SandstormDb.ensureSubscriberHasCredential = function (publishHandler, credentialId) {
    // Helper for publish functions that need to restrict access based on whether the subscriber
    // has a given credential linked. Automatically stops the subscription if the user loses the
    // credential. Returns a boolean indicating whether the user initially has the credential.

    const userId = publishHandler.userId;
    if (userId === credentialId) {
      return true;
    } else {
      const hasCredentialCursor = Meteor.users.find({
        $or: [
          {
            _id: userId,
            "loginCredentials.id": credentialId,
          },
          {
            _id: userId,
            "nonloginCredentials.id": credentialId,
          },
        ],
      });
      if (hasCredentialCursor.count() == 0) {
        publishHandler.stop();
        return false;
      }

      const handle = hasCredentialCursor
          .observe({ removed: function () { publishHandler.stop(); } });

      publishHandler.onStop(function () { handle.stop(); });

      return true;
    }
  };

  Meteor.publish("credentialDetails", function (credentialId) {
    check(credentialId, String);
    if (!SandstormDb.ensureSubscriberHasCredential(this, credentialId)) return;

    return Meteor.users.find({ _id: credentialId },
      { fields: {
        type: 1,
        unverifiedEmail: 1,
        expires: 1,
        createdAt: 1,

        "services.dev.name": 1,
        "services.demo": 1,

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

        "services.oidc.id": 1,
        "services.oidc.email": 1,
        "services.oidc.name": 1,

        "services.saml.id": 1,
        "services.saml.email": 1,
        "services.saml.displayName": 1,
      },
    });
  }),

  Meteor.publish("accountCredentials", function () {
    // Maybe this should be folded into the "credentials" subscription?

    if (!this.userId) return [];

    return Meteor.users.find(
      { _id: this.userId },
      { fields: {
        type: 1,
        profile: 1,
        verifiedEmail: 1,
        loginCredentials: 1,
        nonloginCredentials: 1,
        expires: 1,
        primaryEmail: 1,
      }, });
  });

  makeIdenticon = function (id) {
    const hash = id.slice(0, 32);
    return httpProtocol + "//" + makeWildcardHost("static") + "/identicon/" + hash + "?s=256";
  };

  const Url = Npm.require("url");
  httpProtocol = Url.parse(process.env.ROOT_URL).protocol;
} else {
  const identiconCache = {};

  makeIdenticon = function (id) {
    // Given a cryptographic hash as input, generate an identicon.

    // identicon.js doesn't use more than 32 digits of the hash even if we provide it, but slice it
    // anyway to guarantee this, since historically we sliced it for reasons now obsolete.
    const hash = id.slice(0, 32);

    if (hash in identiconCache) {
      return identiconCache[hash];
    }

    const data = new Identicon(hash, 512).toString();
    const result = "data:image/svg+xml," + encodeURIComponent(data);
    identiconCache[hash] = result;
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

SandstormDb.fillInProfileDefaults = function (credential, profile) {
  // Fill in a user profile based on the data obtained from a linked credential.
  //
  // `credential` is the source credential object.
  // `profile` is the output profile, usually located in the account object.
  //
  // This function will only fill in details that aren't already present.

  if (!profile) {
    throw new Error("missing profile (maybe using old call signature?)");
  }

  const services = credential.services || {};

  if (services.github) {
    profile.name = profile.name || services.github.username || "Name Unknown";
    profile.handle = profile.handle || filterHandle(services.github.username) ||
        filterHandle(profile.name);
  } else if (services.google) {
    profile.name = profile.name || services.google.name || "Name Unknown";
    profile.handle = profile.handle || emailToHandle(services.google.email) ||
        filterHandle(profile.name);
    profile.pronoun = profile.pronoun || GENDERS[services.google.gender] || "neutral";
  } else if (services.oidc) {
    profile.name = profile.name || services.oidc.name || "Name Unknown";
    profile.handle = profile.handle || emailToHandle(services.oidc.email) ||
        filterHandle(profile.name);
  } else if (services.email) {
    const email = services.email.email;
    profile.name = profile.name || emailToHandle(email);
    profile.handle = profile.handle || emailToHandle(email);
  } else if (services.dev) {
    const lowerCaseName = services.dev.name.split(" ")[0].toLowerCase();
    profile.name = profile.name || services.dev.name;
    profile.handle = profile.handle || filterHandle(lowerCaseName);
    profile.pronoun = profile.pronoun ||
        (_.contains(["alice", "carol", "eve"], lowerCaseName) ? "female" :
         _.contains(["bob", "dave"], lowerCaseName) ? "male" : "neutral");
  } else if (services.demo) {
    profile.name = profile.name || "Demo User";
    profile.handle = profile.handle || "demo";
  } else if (services.ldap) {
    const setting = globalDb.collections.settings.findOne({ _id: "ldapNameField" });
    const key = setting ? setting.value : "";
    profile.handle = profile.handle || services.ldap.username;
    profile.name = profile.name || services.ldap.rawAttrs[key] || profile.handle;
  } else if (services.saml) {
    profile.handle = profile.handle || emailToHandle(services.saml.email);
    profile.name = profile.name || services.saml.displayName || profile.handle;
  } else {
    throw new Error("unrecognized authentication service: " +
                    SandstormDb.getServiceName(credential));
  }

  profile.pronoun = profile.pronoun || "neutral";

  // Base identicon on primary credential so that it tends to be consistent across servers.
  profile.identicon = credential._id;
};

SandstormDb.getIntrinsicName = function (credential, usePrivate) {
  const services = credential.services;
  if (services.github) {
    return services.github.username;
  } else if (services.google) {
    return usePrivate ? services.google.email : services.google.name;
  } else if (services.oidc) {
    return services.oidc.id;
  } else if (services.email) {
    return services.email.email;
  } else if (services.dev) {
    return services.dev.name;
  } else if (services.demo) {
    return "demo on " + credential.createdAt.toISOString().substring(0, 10);
  } else if (services.ldap) {
    return services.ldap.username;
  } else if (services.saml) {
    return services.saml.id;
  } else {
    throw new Error("unrecognized authentication service: " +
                    SandstormDb.getServiceName(credential));
  }
};

SandstormDb.getServiceName = function (credential) {
  const keys = Object.keys(credential.services).filter(k => k !== "resume");
  if (keys.length !== 1) {
    throw new Error("expected exactly one auth service: " + keys.join(","));
  }
  return keys[0];
}

SandstormDb.getLoginId = function (credential) {
  return Accounts.loginServices[SandstormDb.getServiceName(credential)].getLoginId(credential);
};

SandstormDb.prototype.getAccountIntrinsicNames = function (account, usePrivate) {
  // Get the user's identity badges, for display to other users. For example, if the user uses
  // GitHub login, this would be their GitHub username. This is displayed to other users to prove
  // this user's identity.

  // TODO(someday): Perhaps users should be able to choose which badges are displayed publicly. For
  //   now, as a heuristic, we choose the credentials which the user has approved for login.
  const credentialIds = account.loginCredentials.map(cred => cred.id);
  return Meteor.users.find({ _id: { $in: credentialIds } }).map(credential => {
    return {
      service: SandstormDb.getServiceName(credential),
      name: SandstormDb.getIntrinsicName(credential, usePrivate),
      // TODO(soon): Add profile link?
    };
  });
};

SandstormDb.getVerifiedEmailsForCredential = function (credential) {
  const services = credential.services;
  if (services.google && services.google.email &&
      services.google.verified_email) { // jscs:ignore requireCamelCaseOrUpperCaseIdentifiers
    return [{ email: services.google.email, primary: true }];
  } else if (services.oidc) {
    return [{ email: services.oidc.email, primary: true }];
  } else if (services.email) {
    return [{ email: services.email.email, primary: true }];
  } else if (services.github && services.github.emails) {
    return _.chain(services.github.emails)
      .filter(function (email) { return email.verified; })
      .map((email) => _.pick(email, "email", "primary"))
      .value();
  } else if (services.ldap) {
    // TODO(cleanup): don't create a new SandstormDb here, make this non-static
    const email = services.ldap.rawAttrs[new SandstormDb().getLdapEmailField()];
    if (email) {
      return [{ email: email, primary: true }];
    }
  } else if (services.saml && services.saml.email) {
    return [{ email: services.saml.email, primary: true }];
  }

  return [];
};

SandstormDb.prototype.findCredentialsByEmail = function (email) {
  // Returns an array of credentials which have the given email address as one of their verified
  // addresses.

  check(email, String);

  // For LDAP, the field containing the e-mail address is configurable...
  const ldapQuery = {};
  ldapQuery["services.ldap.rawAttrs." + this.getLdapEmailField()] = email;

  return Meteor.users.find({ $or: [
    { "services.google.email": email },
    { "services.email.email": email },
    { "services.github.emails.email": email },
    ldapQuery,
    { "services.oidc.email": email },
    { "services.saml.email": email },
  ], }).fetch().filter(function (credential) {
    // Verify that the email is verified, since our query doesn't technically do that.
    return !!_.findWhere(SandstormDb.getVerifiedEmailsForCredential(credential), { email: email });
  });
};

SandstormDb.prototype.findAccountsByEmail = function (email) {
  const credentialIds = _.pluck(this.findCredentialsByEmail(email), "_id");
  return Meteor.users.find({ $or: [
    { "loginCredentials.id": { $in: credentialIds } },
    { "nonloginCredentials.id": { $in: credentialIds } },
  ], }).fetch();
};

SandstormDb.fillInPictureUrl = function (user) {
  const staticHost = httpProtocol + "//" + makeWildcardHost("static");
  let url = staticAssetUrl(user.profile.picture, staticHost);
  if (!url && user.profile && user.profile.identicon) {
    url = makeIdenticon(user.profile.identicon);
  }
  if (!url && user.type === "credential") {
    url = makeIdenticon(user._id);
  }

  user.profile.pictureUrl = url;
};

SandstormDb.getUserCredentialIds = function (user) {
  // Given an account user object, returns an array containing the ID of each credential linked to
  // the account. Always returns the most recently added login credential first.
  if (user && user.loginCredentials) {
    return _.pluck(user.nonloginCredentials.concat(user.loginCredentials), "id").reverse();
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
  //   for linked credentials, so it probably makes more sense for it to be a non-static method
  //   on SandstormDb.

  const credentialIds = SandstormDb.getUserCredentialIds(user);
  const verifiedEmails = {};
  const unverifiedEmails = {};

  credentialIds.forEach(function (id) {
    const credential = Meteor.users.findOne({ _id: id });
    if (credential && credential.services) {
      SandstormDb.getVerifiedEmailsForCredential(credential).forEach(function (verifiedEmail) {
        if (verifiedEmail) {
          verifiedEmails[verifiedEmail.email] = true;
        }
      });
    }

    if (credential && credential.unverifiedEmail) {
      unverifiedEmails[credential.unverifiedEmail] = true;
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

SandstormDb.prototype.addContact = function addContact(ownerId, contactId) {
  check(ownerId, String);
  check(contactId, String);
  const profile = Meteor.users.findOne(contactId).profile;
  this.collections.contacts.upsert({ ownerId: ownerId, accountId: contactId }, {
    ownerId: ownerId,
    petname: profile && profile.name,
    created: new Date(),
    accountId: contactId,
  });
};
