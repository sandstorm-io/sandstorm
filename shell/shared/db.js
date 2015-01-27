// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

// This file defines the database schema.

Packages = new Mongo.Collection("packages");
// Packages which are installed or downloading.
//
// Each contains:
//   _id:  128-bit prefix of SHA-256 hash of spk file, hex-encoded.
//   status:  String.  One of "download", "verify", "unpack", "analyze", "ready", "failed", "delete"
//   progress:  Float.  -1 = N/A, 0-1 = fractional progress (e.g. download percentage),
//       >1 = download byte count.
//   error:  If status is "failed", error message string.
//   manifest:  If status is "ready", the package manifest.  See "Manifest" in grain.capnp.
//   appId:  If status is "ready", the application ID string.  Packages representing different
//       versions of the same app have the same appId.  The spk tool defines the app ID format
//       and can cryptographically verify that a package belongs to a particular app ID.

DevApps = new Mongo.Collection("devapps");
// List of applications currently made available via the dev tools running on the local machine.
// This is normally empty; the only time it is non-empty is when a developer is using the spk tool
// on the local machine to publish an under-development app to this server. That should only ever
// happen on developers' desktop machines.
//
// While a dev app is published, it automatically appears as installed by every user of the server,
// and it overrides all packages with the same application ID. If any instances of those packages
// are currently open, they are killed and reset on publish.
//
// When the dev tool disconnects, the app is automatically unpublished, and any open instances
// are again killed and refreshed.
//
// Each contains:
//   _id:  The application ID string (as with Packages.appId).
//   packageId:  The directory name where the dev package is mounted.
//   timestamp:  Time when the package was last updated. If this changes while the package is
//     published, all running instances are reset. This is used e.g. to reset the app each time
//     changes are made to the source code.
//   manifest:  The app's manifest, as with Packages.manifest.

UserActions = new Mongo.Collection("userActions");
// List of actions that each user has installed which create new grains.  Each app may install
// some number of actions (usually, one).
//
// Each contains:
//   _id:  random
//   userId:  User who has installed this action.
//   packageId:  Package used to run this action.
//   appId:  Same as Packages.findOne(packageId).appId; denormalized for searchability.
//   appVersion:  Same as Packages.findOne(packageId).manifest.appVersion; denormalized for
//       searchability.
//   title:  Human-readable title for this action, e.g. "New Spreadsheet".
//   command:  Manifest.Command to run this action (see package.capnp).

Grains = new Mongo.Collection("grains");
// Grains belonging to users.
//
// Each contains:
//   _id:  random
//   packageId:  _id of the package of which this grain is an instance.
//   appId:  Same as Packages.findOne(packageId).appId; denormalized for searchability.
//   appVersion:  Same as Packages.findOne(packageId).manifest.appVersion; denormalized for
//       searchability.
//   userId:  User who owns this grain.
//   title:  Human-readable string title, as chosen by the user.
//   lastUsed:  Date when the grain was last used by a user.
//
// The following fields *might* also exist. These are temporary hacks used to implement e-mail and
// web publishing functionality without powerbox support; they will be replaced once the powerbox
// is implemented.
//   publicId:  An id used to publicly identify this grain. Used e.g. to route incoming e-mail and
//       web publishing. This field is initialized when first requested by the app.

Sessions = new Mongo.Collection("sessions");
// UI sessions open to particular grains.  A new session is created each time a user opens a grain.
//
// Each contains:
//   _id:  random
//   grainId:  _id of the grain to which this session is connected.
//   hostId: ID part of the hostname from which this grain is being served. I.e. this replaces the
//       '*' in WILDCARD_HOST.
//   timestamp:  Time of last keep-alive message to this session.  Sessions time out after some
//       period.
//   userId:  User who owns this session.

SignupKeys = new Mongo.Collection("signupKeys");
// Invite keys which may be used by users to get access to Sandstorm.
//
// Each contains:
//   _id:  random
//   used:  Boolean indicating whether this key has already been consumed.
//   note:  Text note assigned when creating key, to keep track of e.g. whom the key was for.

ActivityStats = new Mongo.Collection("activityStats");
// Contains usage statistics taken on a regular interval. Each entry is a data point.
//
// Each contains:
//   timestamp: Date when measurements were taken.
//   daily: Contains stats counts pertaining to the last day before the sample time.
//   weekly: Contains stats counts pertaining to the last seven days before the sample time.
//   monthly: Contains stats counts pertaining to the last thirty days before the timestamp.
//
// Each of daily, weekly, and monthly contains:
//   activeUsers: The number of unique users who have used a grain on the server in the time
//       interval. Only counts logged-in users.
//   activeGrains: The number of unique grains that have been used in the time interval.

DeleteStats = new Mongo.Collection("deleteStats");
// Contains records of objects that were deleted, for stat-keeping purposes.
//
// Each contains:
//   type: "grain" or "user"
//   lastActive: Date of the user's or grain's last activity.

FileTokens = new Mongo.Collection("fileTokens");
// Tokens corresponding to files that will be accessed and later cleaned up by the server. This
// is specifically used in routes like backupGrain/restoreGrain where the route is server-side,
// and thus needs its own form of authentication.
// (see https://github.com/EventedMind/iron-router/issues/649)
//
// Each contains:
//   _id:       random. Since they're unguessable, they're also used as the token
//   filePath:  Text path on the local filesystem. Probably will be in /tmp
//   name:      Text name that should be presented to users for this token
//   timestamp: File creation time. Used to figure out when the token and file should be wiped.

ApiTokens = new Mongo.Collection("apiTokens");
// Access tokens for APIs exported by apps.
//
// Originally API tokens were only used by external users through the HTTP API endpoint. However,
// now they are also used to implement SturdyRefs, not just held by external users, but also when
// an app holds a SturdyRef to another app within the same server. See `internal.capnp` for the
// definition of `InternalSturdyRef` which refers to this.
//
// Each contains:
//   _id:       A SHA-256 hash of the token.
//   userId:    For API tokens created by the user through the topbar, which represent the grain's
//              UiView attenuated to the user's own level of access, the `_id` of the user (in
//              the users table).
//   userInfo:  For API tokens created by the app through HackSessionContext, the UserInfo struct
//              that should be passed to `newSession()` when exercising this token, in decoded (JS
//              object) format. This is a temporary hack.
//   appRef:    If present, this token represents an arbitrary Cap'n Proto capability exported by
//              the app (whereas without this it strictly represents UiView). appRef is the encoded
//              AppSturdyRef (encoded as a Cap'n Proto message with AppSturdyRef as the root; this
//              is the format that node-capnp automatically uses for `AnyPointer` fields).
//   grainId:   The grain servicing this API.
//   petname:   Human-readable label for this access token, useful for identifying tokens for
//              revocation.
//   created:   Date when this token was created.
//   expires:   Optional expiration Date. If undefined, the token does not expire.
//   owner:     Optionally specifies to whom this token belongs, in the sense of a SturdyRef owner.
//              If present, the token can ONLY be used by that owner; otherwise anyone on the
//              internet can use it. The structure of this field is defined by
//              InternalSturdyRef.Owner.

CapTokens = new Mongo.Collection("capTokens");
// Much like API tokens, but represent arbitrary capabilities.

StatsTokens = new Mongo.Collection("statsTokens");
// Access tokens for the Stats collection
//
// These tokens are used for accessing the ActivityStats collection remotely
// (ie. from a dashboard webapp)
//
// Each contains:
//   _id:       The token. At least 128 bits entropy (Random.id(22)).

if (Meteor.isServer) {
  Meteor.publish("credentials", function () {
    // Data needed for isSignedUp() and isAdmin() to work.

    if (this.userId) {
      return Meteor.users.find({_id: this.userId},
          {fields: {signupKey: 1, isAdmin: 1, expires: 1}});
    } else {
      return [];
    }
  });

  // The first user to sign in should be automatically upgraded to admin.
  Accounts.onCreateUser(function (options, user) {
    if (Meteor.users.find().count() === 0) {
      user.isAdmin = true;
      user.signupKey = "admin";
    }

    if (options.profile) {
      user.profile = options.profile;
    }

    return user;
  });
}

isDemoUser = function() {
  // Returns true if this is a demo user.

  var user = Meteor.user();
  if (user && user.expires) {
    return true;
  } else {
    return false;
  }
}

isSignedUp = function() {
  // Returns true if the user has presented an invite key.

  var user = Meteor.user();
  if (user && user.signupKey) {
    return true;
  } else {
    return false;
  }
}

isSignedUpOrDemo = function () {
  var user = Meteor.user();
  if (user && (user.signupKey || user.expires)) {
    return true;
  } else {
    return false;
  }
}

isAdmin = function() {
  // Returns true if the user is the administrator.

  var user = Meteor.user();
  if (user && user.isAdmin) {
    return true;
  } else {
    return false;
  }
}

var wildcardHost = Meteor.settings.public.wildcardHost.split("*");

matchWildcardHost = function(host) {
  // See if the hostname is a member of our wildcard. If so, extract the ID.

  var prefix = wildcardHost[0];
  var suffix = wildcardHost[1];
  if (host.lastIndexOf(prefix, 0) >= 0 &&
      host.indexOf(suffix, -suffix.length) >= 0 &&
      host.length >= prefix.length + suffix.length) {
    var id = host.slice(prefix.length, -suffix.length);
    if (id.match(/^[a-z0-9]*$/)) {
      return id;
    }
  }

  return null;
}

makeWildcardHost = function (id) {
  return wildcardHost[0] + id + wildcardHost[1];
}

if (Meteor.isServer) {
  var Url = Npm.require("url");
  getWildcardOrigin = function () {
    // The wildcard URL can be something like "foo-*-bar.example.com", but sometimes when we're
    // trying to specify a pattern matching hostnames (say, a Content-Security-Policy directive),
    // an astrisk is only allowed as the first character and must be followed by a period. So we need
    // "*.example.com" instead -- which matches more than we actually want, but is the best we can
    // really do. We also add the protocol to the front (again, that's what CSP wants).

    // TODO(cleanup): `protocol` is computed in other files, like proxy.js. Put it somewhere common.
    var protocol = Url.parse(process.env.ROOT_URL).protocol;

    var dotPos = wildcardHost[1].indexOf(".");
    if (dotPos < 0) {
      return protocol + "//*";
    } else {
      return protocol + "//*" + wildcardHost[1].slice(dotPos);
    }
  }
}
