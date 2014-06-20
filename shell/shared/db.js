// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// This file is part of the Sandstorm platform implementation.
//
// Sandstorm is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Sandstorm is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public
// License along with Sandstorm.  If not, see
// <http://www.gnu.org/licenses/>.

// This file defines the database schema.

Packages = new Meteor.Collection("packages");
// Packages which are installed or downloadloading.
//
// Each contains:
//   _id:  128-bit prefix of SHA-256 hash of spk file, hex-encoded.
//   status:  String.  One of "download", "verify", "unpack", "analyze", "ready", "failed"
//   progress:  Float.  -1 = N/A, 0-1 = fractional progress (e.g. download percentage),
//       >1 = download byte count.
//   error:  If status is "failed", error message string.
//   manifest:  If status is "ready", the package manifest.  See "Manifest" in grain.capnp.
//   appId:  If status is "ready", the application ID string.  Packages representing different
//       versions of the same app have the same appId.  The spk tool defines the app ID format
//       and can cryptographically verify that a package belongs to a particular app ID.

DevApps = new Meteor.Collection("devapps");
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

UserActions = new Meteor.Collection("userActions");
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

Grains = new Meteor.Collection("grains");
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

Sessions = new Meteor.Collection("sessions");
// UI sessions open to particular grains.  A new session is created each time a user opens a grain.
//
// Each contains:
//   _id:  random
//   grainId:  _id of the grain to which this session is connected.
//   port:  TCP port number on which this session is being exported.
//   timestamp:  Time of last keep-alive message to this session.  Sessions time out after some
//       period.

SignupKeys = new Meteor.Collection("signupKeys");
// Invite keys which may be used by users to get access to Sandstorm.
//
// Each contains:
//   _id:  random
//   used:  Boolean indicating whether this key has already been consumed.
//   note:  Text note assigned when creating key, to keep track of e.g. whom the key was for.

ActivityStats = new Meteor.Collection("activityStats");
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

FileTokens = new Meteor.Collection("fileTokens");
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

if (Meteor.isServer) {
  Meteor.publish("credentials", function () {
    // Data needed for isSignedUp() and isAdmin() to work.

    if (this.userId) {
      return Meteor.users.find({_id: this.userId}, {fields: {signupKey: 1, isAdmin: 1}});
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

isSignedUp = function() {
  // Returns true if the user has presented an invite key.

  var user = Meteor.user();
  if (user && user.signupKey) {
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
