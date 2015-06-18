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
//   appTitle:  Same as Packages.findOne(packageId).manifest.appTitle.defaultText; denormalized so
//       that clients can access it without subscribing to the Packages collection.
//   appVersion:  Same as Packages.findOne(packageId).manifest.appVersion; denormalized for
//       searchability.
//   appMarketingVersion:  Human-readable presentation of the app version, e.g. "2.9.17"
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
//   private: If true, then knowledge of `_id` does not suffice to open this grain.
//
// The following fields *might* also exist. These are temporary hacks used to implement e-mail and
// web publishing functionality without powerbox support; they will be replaced once the powerbox
// is implemented.
//   publicId:  An id used to publicly identify this grain. Used e.g. to route incoming e-mail and
//       web publishing. This field is initialized when first requested by the app.

RoleAssignments = new Mongo.Collection("roleAssignments");
// Edges in the permissions sharing graph.
//
// To share a permission with another user is to declare "if I have this permission, then so should
// the recipient". A bundle of such declarations by a single sharer directed at a single recipient
// for a single grain is called a "role assignment". A grain's owner always has every permission,
// but permissions for other users must be computed from this collection.
//
// Any grain for which a user has received a role assignment should show up in that user's grain
// list. However, the user may only access a grain if there is a path of *active* role assignments
// leading from the grain owner to that user, precisely as if every role assignment carried a
// special "can open grain" permission.
//
// Each contains:
//   _id: random
//   grainId: The `_id` of the grain whose permissions are being shared.
//   sharer: The `_id` of the user who is sharing these permissions.
//   recipient: The `_id` of the user who receives these permissions.
//   roleAssignment: A JSON-encoded Grain.ViewSharingLink.RoleAssignment representing the
//                   received permissions. The sharer is allowed to modify this later.
//   active: Flag indicating that this role assignment has not been revoked. The sharer is allowed
//           to flip this bit, but only the recipient is allowed to delete the role assignment.
//   petname: Human-readable label chosen by and only visible to the sharer.
//   title: Human-readable title as chosen by the recipient. Used in the same places that
//          `grain.title` is used for the grain's owner.
//   created: Date when this role assignment was created.
//   parent: If present, the `_id` of the entry in ApiTokens from which this was derived.

Contacts = new Mongo.Collection("contacts");
// Edges in the social graph.
//
// If Alice has Bob as a contact, then she is allowed to see Bob's profile information and Bob
// will show up in her user-picker UI for actions like share-by-identity.
//
// Contacts are not symmetric. Bob might be one of Alice's contacts even if Alice is not one of
// Bob's.
//
// Each contains:
//   _id: random
//   ownerId: The `_id` of the user who owns this contact.
//   userId:  The `_id` of the contacted user.
//   petname: Human-readable label chosen by and only visible to the owner. Uniquely identifies
//            the contact to the owner.
//   created: Date when this contact was created.

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
//   hashedToken: If the session is owned by an anonymous user, the _id of the entry in ApiTokens
//       that was used to open it. Note that for old-style sharing (i.e. when !grain.private),
//       anonymous users can get access without an API token and so neither userId nor hashedToken
//       are present.

SignupKeys = new Mongo.Collection("signupKeys");
// Invite keys which may be used by users to get access to Sandstorm.
//
// Each contains:
//   _id:  random
//   used:  Boolean indicating whether this key has already been consumed.
//   note:  Text note assigned when creating key, to keep track of e.g. whom the key was for.
//   email: If this key was sent as an email invite, the email address to which it was sent.

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
//   type: "grain" or "user" or "appDemoUser"
//   lastActive: Date of the user's or grain's last activity.

FileTokens = new Mongo.Collection("fileTokens");
// Tokens corresponding to backup files that are currently stored on the server. A user receives
// a token when they create a backup file (either by uploading it, or by backing up one of their
// grains) and may use the token to read the file (either to download it, or to restore a new
// grain from it).
//
// Each contains:
//   _id:       The unguessable token string.
//   name:      Suggested filename.
//   timestamp: File creation time. Used to figure out when the token and file should be wiped.

ApiTokens = new Mongo.Collection("apiTokens");
// Access tokens for APIs exported by apps.
//
// Originally API tokens were only used by external users through the HTTP API endpoint. However,
// now they are also used to implement SturdyRefs, not just held by external users, but also when
// an app holds a SturdyRef to another app within the same server. See the various `save()`,
// `restore()`, and `drop()` methods in `grain.capnp` (on `SansdtormApi`, `AppPersistent`, and
// `MainView`) -- the fields of type `Data` are API tokens.
//
// Each contains:
//   _id:       A SHA-256 hash of the token.
//   grainId:   The grain servicing this API. (Not present if the API isn't serviced by a grain.)
//   userId:    For UiView capabilities, this is the user for whom the view is attenuated. That
//              is, the UiView's newSession() method will intersect the requested permissions with
//              this user's permissions before forwarding on to the underlying app. If `userId` is
//              not present, then no user attenuation is applied, i.e. this is a raw UiView as
//              implemented by the app. (The `roleAssignment` field, below, may still apply.)
//              For non-UiView capabilities, `userId` is never present.
//              Note that this is NOT the user against whom the `requiredPermissions` parameter of
//              `SandstormApi.restore()` is checked; that would be `owner.grain.introducerUser`.
//   userInfo:  *DEPRECATED* For API tokens created by the app through HackSessionContext, the
//              UserInfo struct that should be passed to `newSession()` when exercising this token,
//              in decoded (JS object) format. This is a temporary hack. `userId` is never present
//              when `userInfo` is present.
//   roleAssignment: If this API token represents a UiView, this field contains a JSON-encoded
//              Grain.ViewSharingLink.RoleAssignment representing the permissions it carries. These
//              permissions will be intersected with those held by `userId` when the view is opened.
//   forSharing: If true, requests sent to the HTTP API endpoint with this token will be treated as
//              anonymous rather than as directly associated with `userId`. This has no effect on
//              the permissions granted.
//   objectId:  If present, this token represents an arbitrary Cap'n Proto capability exported by
//              the app or its supervisor (whereas without this it strictly represents UiView).
//              sturdyRef is the JSON-encoded SupervisorObjectId (defined in `supervisor.capnp`).
//              Note that if the SupervisorObjectId contains an AppObjectId, that field is
//              treated as type AnyPointer, and so encoded as a raw Cap'n Proto message.
//   frontendRef: If present, this token actually refers to an object implemented by the front-end,
//              not a particular grain. (`grainId` and `userId` are not set.) This is an object
//              containing exactly one of the following fields:
//       notificationHandle: A `Handle` for an ongoing notification, as returned by
//                           `NotificationTarget.addOngoing`. The value is an `_id` from the
//                           `Notifications` collection.
//   petname:   Human-readable label for this access token, useful for identifying tokens for
//              revocation. This should be displayed when visualizing incoming capabilities to
//              the grain identified by `grainId`.
//   created:   Date when this token was created.
//   expires:   Optional expiration Date. If undefined, the token does not expire.
//   owner:     A `ApiTokenRefOwner` (defined in `supervisor.capnp`, stored as a JSON object)
//              as passed to the `save()` call that created this token. If not present, treat
//              as `webkey` (the default for `ApiTokenOwner`).
//   expiresIfUnused:
//              Optional Date after which the token, if it has not been used yet, expires.
//              This field should be cleared on a token's first use.
//   requirements: List of conditions which must hold for this token to be considered valid.
//              Semantically, this list specifies the powers which were *used* to originally
//              create the token. If any condition in the list becomes untrue, then the token must
//              be considered revoked, and all live refs and sturdy refs obtained transitively
//              through it must also become revoked. Each item is the JSON serialization of the
//              `MembraneRequirement` structure defined in `supervisor.capnp`.
//
// It is important to note that a token's owner and provider are independent from each other. To
// illustrate, here is an approximate definition of ApiToken in pseudo Cap'n Proto schema language:
//
// struct ApiToken {
//   owner :ApiTokenOwner;
//   provider :union {
//     grain :group {
//       grainId :Text;
//       union {
//         uiView :group {
//           userId :Text;
//           roleAssignment :RoleAssignment;
//           forSharing :Bool;
//         }
//         objectId :SupervisorObjectId;
//       }
//     }
//     frontendRef :union {
//        notificationHandle :Text;
//     }
//   }
//   requirements: List(Supervisor.MembraneRequirement);
//   ...
// }

Notifications = new Mongo.Collection("notifications");
// Notifications for a user.
//
// Each contains:
//   _id:          random
//   ongoing:      If present, this is an ongoing notification, and this field contains an
//                 ApiToken referencing the `OngoingNotification` capability.
//   grainId:      The grain originating this notification, if any.
//   userId:       The user receiving the notification.
//   text:         The JSON-ified LocalizedText to display in the notification.
//   isUnread:     Boolean indicating if this notification is unread.
//   timestamp:    Date when this notification was last updated

StatsTokens = new Mongo.Collection("statsTokens");
// Access tokens for the Stats collection
//
// These tokens are used for accessing the ActivityStats collection remotely
// (ie. from a dashboard webapp)
//
// Each contains:
//   _id:       The token. At least 128 bits entropy (Random.id(22)).

Misc = new Mongo.Collection("misc");
// Miscellaneous configuration and other settings
//
// This table is currently only used for persisting BASE_URL from one session to the next,
// but in general any miscellaneous settings should go in here
//
// Each contains:
//   _id:       The name of the setting. eg. "BASE_URL"
//   value:     The value of the setting.

Settings = new Mongo.Collection("settings");
// Settings for this Sandstorm instance go here. They are configured through the adminSettings
// route. This collection differs from misc in that this collection is completely user controlled.
//
// Each contains:
//   _id:       The name of the setting. eg. "MAIL_URL"
//   value:     The value of the setting.
//   potentially other fields that are unique to the setting

Migrations = new Mongo.Collection("migrations");
// This table tracks which migrations we have applied to this instance.
// It contains a single entry:
//   _id:       "migrations_applied"
//   value:     The number of migrations this instance has successfully completed.

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
    // Dev users are identified by having the devName field
    // Don't count them in our find and don't give them admin
    if (Meteor.users.find({devName: {$exists: 0}}).count() === 0 && !user.devName) {
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

isAdminById = function(id) {
  // Returns true if the user's id is the administrator.

  var user = Meteor.users.findOne({_id: id}, {fields: {isAdmin: 1}})
  if (user && user.isAdmin) {
    return true;
  } else {
    return false;
  }
}

var wildcardHost = Meteor.settings.public.wildcardHost.toLowerCase().split("*");

if (wildcardHost.length != 2) {
  throw new Error("Wildcard host must contain exactly one asterisk.");
}

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

allowDevAccounts = function () {
  var setting = Settings.findOne({_id: "devAccounts"});
  if (setting) {
    return setting.value;
  } else {
    return Meteor.settings && Meteor.settings.public &&
           Meteor.settings.public.allowDevAccounts;
  }
};
