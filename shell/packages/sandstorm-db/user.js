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

var Crypto = Npm.require("crypto");
var Future = Npm.require("fibers/future");

userPictureUrl = function (user) {
  if (user.services && !(user.profile && user.profile.picture)) {
    // Try to determine user's avatar URL from login service.

    var google = user.services.google;
    if (google && google.picture) {
      return google.picture;
    }

    var github = user.services.github;
    if (github && github.id) {
      return "https://avatars.githubusercontent.com/u/" + github.id;
    }

    // Note that we do NOT support Gravatar for email addresses because pinging Gravatar would be
    // a data leak, revealing that the user has logged into this Sandstorm server. Google and
    // Github are different because they are actually the identity providers, so they already know
    // the user logged in.
  }
}

fetchPicture = function (url) {
  try {
    var result = HTTP.get(url, {
      npmRequestOptions: { encoding: null },
      timeout: 5000
    });

    var metadata = {};

    metadata.mimeType = result.headers["content-type"];
    if (metadata.mimeType.lastIndexOf("image/png", 0) === -1 &&
        metadata.mimeType.lastIndexOf("image/jpeg", 0) === -1) {
      throw new Error("unexpected Content-Type:", metadata.mimeType);
    }
    var enc = result.headers["content-encoding"];
    if (enc && enc !== "identity") {
      metadata.encoding = enc;
    }

    return addStaticAsset(metadata, result.content);
  } catch (err) {
    console.error("failed to fetch user profile picture:", url, err.stack);
  }
}

var ValidHandle = Match.Where(function (handle) {
  check(handle, String);
  return !!handle.match(/^[a-z_][a-z0-9_]*$/);
});

Accounts.onCreateUser(function (options, user) {
  // The first non-dev user to sign in should be automatically upgraded to admin.
  // Dev users are identified by having the devName field.
  if (Meteor.users.find({devName: {$exists: 0}}).count() === 0 && !user.devName) {
    user.isAdmin = true;
    user.signupKey = "admin";
  }

  // Check profile.
  if (options.profile) {
    // TODO(cleanup): This check also appears in accounts-ui-methods.js.
    check(options.profile, Match.ObjectIncluding({
      name: Match.OneOf(null, Match.Optional(String)),
      handle: Match.Optional(ValidHandle),
      pronoun: Match.Optional(Match.OneOf("male", "female", "neutral", "robot")),
    }));

    user.profile = options.profile;
  } else {
    user.profile = {};
  }

  // Try downloading avatar.
  var url = userPictureUrl(user);
  if (url) {
    var assetId = fetchPicture(url);
    if (assetId) {
      user.profile.picture = assetId;
    }
  }
  var identity = _.pick(user.profile, "name", "handle", "pronouns", "picture");
  identity.main = true;

  var serviceUserId;
  if ("devName" in user) {
    identity.service = "dev";
    serviceUserId = user.devName;
  } else if ("expires" in user) {
    identity.service = "demo";
    serviceUserId = user._id;
  } else if (user.services && "google" in user.services) {
    identity.service = "google";
    if (user.services.google.email && user.services.google.verified_email) {
      identity.verifiedEmail = user.services.google.email;
    }
    serviceUserId = user.services.google.id;
  } else if (user.services && "github" in user.services) {
    identity.service = "github";
    if (user.services.github.email) {
      identity.unverifiedEmail = user.services.github.email;
    }
    serviceUserId = user.services.github.id;
  } else if (user.services && "emailToken" in user.services) {
    identity.service = "emailToken";
    identity.verifiedEmail = user.services.emailToken.email;
    serviceUserId = user.services.emailToken.email;
  }
  identity.id = Crypto.createHash("sha256")
      .update(identity.service + ":" + serviceUserId).digest("hex");

  user.identities = [identity];
  return user;
});

Accounts.validateLoginAttempt(function(info) {
  if (info.allowed) {
    if (info.type === "resume") {
      return true;
    } else {
      var identities = info.user.identities;
      for (var ii = 0; ii < identities.length; ++ii) {
        if (identities[ii].service === info.type) {
          return !identities[ii].noLogin;
        }
      }
    }
  }
});

Meteor.users._ensureIndex("identities.id", {unique: 1, sparse: 1});
