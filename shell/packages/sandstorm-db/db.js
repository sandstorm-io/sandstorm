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

// Users = new Mongo.Collection("users");
// The users collection is special and can be accessed through `Meteor.users`.
// See https://docs.meteor.com/#/full/meteor_users. Entries in the users collection correspond to
// accounts. Each represents a capability store belonging to a human.
//
// Note that accounts are not the same thing as identities. An account may have multiple identities
// attached to it. Identities provide a way to authenticate the user and are also used to present
// globally unique and stable user indentifiers to grains via `Grain.UserInfo.userId`.
//
// Each entry in this collection contains:
//   _id: Random.
//   createdAt: Date when this entry was added to the collection.
//   lastActive: Date of the user's most recent interaction with this Sandstorm server.
//   profile: Object containing profile data editable by the user and visible to other users. May
//            include the following fields. Note that if any field is missing, the first fallback
//            is to check `services` for details provided by the identity provider (the details
//            of which differ per-provider). Only if that is also missing do we fall back to
//            defaults.
//       name: String containing the display name of the user. Default: first part of email.
//       handle: String containing the user's preferred handle. Default: first part of email.
//       picture: _id into the StaticAssets table for the user's picture. Default: identicon.
//       pronoun: One of "male", "female", "neutral", or "robot". Default: neutral.
//   services: Object containing login and identity data used by Meteor authentication services.
//   isAdmin: Boolean indicating whether this user is allowed to access the Sandstorm admin panel.
//   signupKey: If this is an invited user, then this field contains their signup key.
//   signupNote: If the user was invited through a link, then this field contains the note that the
//               inviter admin attached to the key.
//   signupEmail: If the user was invited by email, then this field contains the email address that
//                the invite was sent to.
//   plan: _id of an entry in the Plans table which determines the user's qutoa.
//   storageUsage: Number of bytes this user is currently storing.
//   expires: Date when this user's account should be deleted. Only present for demo users.
//   isAppDemoUser: True if this is a demo user who arrived via an /appdemo/ link.
//   payments: Object defined by payments module, if loaded.

Packages = new Mongo.Collection("packages");
// Packages which are installed or downloading.
//
// Each contains:
//   _id:  128-bit prefix of SHA-256 hash of spk file, hex-encoded.
//   status:  String.  One of "download", "verify", "unpack", "analyze", "ready", "failed", "delete"
//   progress:  Float.  -1 = N/A, 0-1 = fractional progress (e.g. download percentage),
//       >1 = download byte count.
//   error:  If status is "failed", error message string.
//   manifest:  If status is "ready", the package manifest.  See "Manifest" in package.capnp.
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
//   cachedViewInfo: The JSON-encoded result of `UiView.getViewInfo()`, cached from the most recent
//                   time a session to this grain was opened.
//
// The following fields *might* also exist. These are temporary hacks used to implement e-mail and
// web publishing functionality without powerbox support; they will be replaced once the powerbox
// is implemented.
//   publicId:  An id used to publicly identify this grain. Used e.g. to route incoming e-mail and
//       web publishing. This field is initialized when first requested by the app.

RoleAssignments = new Mongo.Collection("roleAssignments");
// *OBSOLETE* Before `user` was a variant of ApiTokenOwner, this collection was used to store edges
// in the permissions sharing graph. This functionality has been subsumed by the ApiTokens
// collection.

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
//   powerboxView: If present, this is a view that should be presented as part of a powerbox
//       interaction.
//     offer: The webkey that corresponds to cap that was passed to the `offer` RPC.

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
//       ipNetwork: An IpNetwork capability that is implemented by the frontend. Eventually, this
//                  will be moved out of the frontend and into the backend, but we'll migrate the
//                  database when that happens. This field contains the boolean true to signify that
//                  it has been set.
//       ipInterface: Ditto IpNetwork, except it's an IpInterface.
//   parentToken: If present, then this token represents exactly the capability represented by
//              the ApiToken with _id = parentToken, except possibly (if it is a UiView) attenuated
//              by `roleAssignment` (if present). To facilitate permissions computations, if the
//              capability is a UiView, then `grainId` is set to the backing grain and `userId` is
//              set to the user who shared the view. None of `userInfo`, `objectId`, or
//              `frontendRef` are present when `parentToken` is present.
//   petname:   Human-readable label for this access token, useful for identifying tokens for
//              revocation. This should be displayed when visualizing incoming capabilities to
//              the grain identified by `grainId`.
//   created:   Date when this token was created.
//   revoked:   If true, then this sturdyref has been revoked and can no longer be restored. It may
//              become un-revoked in the future.
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
//        ipNetwork :Bool;
//        ipInterface :Bool;
//     }
//     child :group {
//       parentToken :Text;
//       union {
//         uiView :group {
//           grainId :Text;
//           userId :Text;
//           roleAssignment :RoleAssignment = (allAccess = ());
//         }
//         other :Void;
//       }
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

StaticAssets = new Mongo.Collection("staticAssets");
// Collection of static assets served up from the Sandstorm server's "static" host. We only
// support relatively small assets: under 1MB each.
//
// Each contains:
//   _id:       Random ID; will be used in the URL.
//   hash:      A SHA-256 hash of the data, used to de-dupe.
//   mimeType:  MIME type of the asset, suitable for Content-Type header.
//   encoding:  Either "gzip" or not present, suitable for Content-Encoding header.
//   content:   The asset content (byte buffer).
//   refcount:  Number of places where this asset's ID appears in the database. Since Mongo doesn't
//       have transactions, this needs to bias towards over-counting; a backup GC could be used
//       to catch leaked assets, although it's probably not a big deal in practice.

AssetUploadTokens = new Mongo.Collection("assetUploadTokens");
// Collection of tokens representing a single-use permission to upload an asset, such as a new
// profile picture.
//
// Each contains:
//   _id:       Random ID.
//   purpose:   Contains one of the following, indicating how the asset is to be used:
//       profilePicture: Indicates that the upload is a new profile picture. Contains fields:
//           userId: User whose picture shall be replaced.
//           identityId: Which of the user's identities shall be updated.
//   expires:   Time when this token will go away if unused.

Plans = new Mongo.Collection("plans");
// Subscription plans, which determine quota.
//
// Each contains:
//   _id: Plan ID, usually a short string like "free", "standard", "large", "mega", ...
//   storage: Number of bytes this user is allowed to store.
//   compute: Number of kilobyte-RAM-seconds this user is allowed to consume.
//   computeLabel: Label to display to the user describing this plan's compute units.
//   grains: Total number of grains this user can create (often `Infinity`).
//   price: Price per month in US cents.

if (Meteor.isServer) {
  Meteor.publish("credentials", function () {
    // Data needed for isSignedUp() and isAdmin() to work.

    if (this.userId) {
      return [
        Meteor.users.find({_id: this.userId},
            {fields: {signupKey: 1, isAdmin: 1, expires: 1, storageUsage: 1,
                      plan: 1, hasCompletedSignup: 1}}),
        Plans.find()
      ];
    } else {
      return [];
    }
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

  if (!user) return false;  // not signed in

  if (user.expires) return false;  // demo user.

  if (Meteor.settings.public.allowUninvited) return true;  // all accounts qualify

  if (user.signupKey) return true;  // user is invited

  return false;
}

isSignedUpOrDemo = function () {
  var user = Meteor.user();

  if (!user) return false;  // not signed in

  if (user.expires) return true;  // demo user.

  if (Meteor.settings.public.allowUninvited) return true;  // all accounts qualify

  if (user.signupKey) return true;  // user is invited

  return false;
}

isUserOverQuota = function (user) {
  // Return false if user has quota space remaining, true if it is full. When this returns true,
  // we will not allow the user to create new grains, though they may be able to open existing ones
  // which may still increase their storage usage.
  //
  // (Actually returns a string which can be fed into `billingPrompt` as the reason.)

  if (!Meteor.settings.public.quotaEnabled || user.isAdmin) return false;

  var plan = Plans.findOne(user.plan || "free");

  if (plan.grains < Infinity) {
    var count = Grains.find({userId: user._id}, {fields: {}, limit: plan.grains}).count();
    if (count >= plan.grains) return "outOfGrains";
  }

  return plan && user.storageUsage && user.storageUsage >= plan.storage && "outOfStorage";
}

isUserExcessivelyOverQuota = function (user) {
  // Return true if user is so far over quota that we should prevent their existing grains from
  // running at all.
  //
  // (Actually returns a string which can be fed into `billingPrompt` as the reason.)

  if (!Meteor.settings.public.quotaEnabled || user.isAdmin) return false;

  var plan = Plans.findOne(user.plan || "free");

  if (plan.grains < Infinity) {
    var count = Grains.find({userId: user._id}, {fields: {}, limit: plan.grains * 2}).count();
    if (count >= plan.grains * 2) return "outOfGrains";
  }

  return plan && user.storageUsage && user.storageUsage >= plan.storage * 1.2 && "outOfStorage";
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

findAdminUserForToken = function (token) {
  if (!token.requirements) {
    return;
  }
  var requirements = token.requirements.filter(function (requirement) {
    return "userIsAdmin" in requirement;
  });

  if (requirements.length > 1) {
    return;
  }
  if (requirements.length === 0) {
    return;
  }
  return requirements[0].userIsAdmin;
};

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

roleAssignmentPattern = {
  none : Match.Optional(null),
  allAccess: Match.Optional(null),
  roleId: Match.Optional(Match.Integer),
  addPermissions: Match.Optional([Boolean]),
  removePermissions: Match.Optional([Boolean]),
};

SandstormDb = function () {
  this.collections = {
    // Direct access to underlying collections. DEPRECATED.
    //
    // TODO(cleanup): Over time, we will provide methods covering each supported query and remove
    //   direct access to the collections.

    packages: Packages,
    devApps: DevApps,
    userActions: UserActions,
    grains: Grains,
    contacts: Contacts,
    sessions: Sessions,
    signupKeys: SignupKeys,
    activityStats: ActivityStats,
    deleteStats: DeleteStats,
    fileTokens: FileTokens,
    apiTokens: ApiTokens,
    notifications: Notifications,
    statsTokens: StatsTokens,
    misc: Misc,
    settings: Settings,

    // Intentionally omitted:
    // - Migrations, since it's used only within this package.
    // - RoleAssignments, since it is deprecated and only used by the migration that eliminated it.
  };
};

// TODO(cleanup): These methods should not be defined freestanding and should use collection
//   objects created in SandstormDb's constructor rather than globals.

_.extend(SandstormDb.prototype, {
  isDemoUser: isDemoUser,
  isSignedUp: isSignedUp,
  isSignedUpOrDemo: isSignedUpOrDemo,
  isUserOverQuota: isUserOverQuota,
  isUserExcessivelyOverQuota: isUserExcessivelyOverQuota,
  isAdmin: isAdmin,
  isAdminById: isAdminById,
  findAdminUserForToken: findAdminUserForToken,
  matchWildcardHost: matchWildcardHost,
  makeWildcardHost: makeWildcardHost,
  allowDevAccounts: allowDevAccounts,
  roleAssignmentPattern: roleAssignmentPattern,
});

if (Meteor.isServer) {
  SandstormDb.prototype.getWildcardOrigin = getWildcardOrigin;
}

// =======================================================================================
// Below this point are newly-written or refactored functions.

_.extend(SandstormDb.prototype, {
  // TODO(cleanup): These methods shouldn't take a raw mongo queries or "aggregations" as inputs.
  //   We want methods corresponding to each kind of query that is performed in practice. Letting
  //   the caller pass an arbitrary query and aggregations is problematic because:
  //   - We can't type-check them to prevent Mongo injections.
  //   - It defeats the purpose of clearly seeing what kinds of queries we need to support, and
  //     therefore what kind of indexes we might need.
  //   - It doesn't make it any easier for us to substitute a non-Mongo database in the future.
  //   - If the caller is just going to pass in a match-all query, we may be forcing Mongo into
  //     a slower path by using $and.
  userGrains: function userGrains (user, query, aggregations) {
    var filteredQuery = { $and: [ { userId: user}, query ] };
    return this.collections.grains.find(filteredQuery, aggregations);
  },

  currentUserGrains: function currentUserGrains (query, aggregations) {
    return this.userGrains(Meteor.userId(), query, aggregations);
  },

  userApiTokens: function userApiTokens (user) {
    return this.collections.apiTokens.find({'owner.user.userId': user});
  },

  currentUserApiTokens: function currentUserApiTokens () {
    return this.userApiTokens(Meteor.userId());
  },

  userActions: function userActions (user, query, aggregations) {
    var filteredQuery = { $and: [ {userId: user}, query ] };
    return this.collections.userActions.find(filteredQuery, aggregations);
  },

  currentUserActions: function currentUserActions (query, aggregations) {
    return this.userActions(Meteor.userId(), query, aggregations);
  },

  getPlan: function (id) {
    check(id, String);
    var plan = Plans.findOne(id);
    if (!plan) {
      throw new Error("no such plan: " + id);
    }
    return plan;
  },

  listPlans: function () {
    return Plans.find({}, {sort: {price: 1}});
  },

  getMyPlan: function () {
    var user = Meteor.user();
    return user && Plans.findOne(user.plan || "free");
  },

  getMyUsage: function (user) {
    user = user || Meteor.user();
    if (user && user.pseudoUsage) {
      if (Meteor.isClient) {
        return user.pseudoUsage;  // filled by pseudo-subscription to "getMyUsage"
      } else {
        return {
          grains: Grains.find({userId: user._id}).count(),
          storage: user.storageUsage || 0,
          compute: 0   // not tracked yet
        };
      }
    } else {
      return {grains: 0, storage: 0, compute: 0};
    }
  },

  isUninvitedFreeUser: function () {
    if (!Meteor.settings.public.allowUninvited) return false;

    var user = Meteor.user();
    return user && !user.expires && (!user.plan || user.plan === "free");
  },

  getSetting: function (name) {
    var setting = Settings.findOne(name);
    return setting && setting.value;
  },
});

if (Meteor.isServer) {
  var Crypto = Npm.require("crypto");
  var ContentType = Npm.require("content-type");
  var Zlib = Npm.require("zlib");

  // TODO(cleanup): Node 0.12 has a `gzipSync` but 0.10 (which Meteor still uses) does not.
  var gzipSync = Meteor.wrapAsync(Zlib.gzip, Zlib);

  var BufferSmallerThan = function (limit) {
    return Match.Where(function (buf) {
      check(buf, Buffer);
      return buf.length < limit;
    });
  }

  var DatabaseId = Match.Where(function (s) {
    check(s, String);
    return !!s.match(/^[a-zA-Z0-9_]+$/);
  });

  addStaticAsset = function (metadata, content) {
    // Add a new static asset to the database. If `content` is a string rather than a buffer, it
    // will be automatically gzipped before storage; do not specify metadata.encoding in this case.

    if (typeof content === "string" && !metadata.encoding) {
      content = gzipSync(new Buffer(content, "utf8"));
      metadata.encoding = "gzip";
    }

    check(metadata, {
      mimeType: String,
      encoding: Match.Optional("gzip")
    });
    check(content, BufferSmallerThan(1 << 20));

    // Validate content type.
    metadata.mimeType = ContentType.format(ContentType.parse(metadata.mimeType));

    var hasher = Crypto.createHash("sha256");
    hasher.update(metadata.mimeType + "\n" + metadata.encoding + "\n", "utf8");
    hasher.update(content);
    var hash = hasher.digest("base64");

    var existing = StaticAssets.findAndModify({
      query: {hash: hash, refcount: {$gte: 1}},
      update: {$inc: {refcount: 1}},
      fields: {_id: 1, refcount: 1},
    });
    if (existing) {
      return existing._id;
    }

    return StaticAssets.insert(_.extend({
      hash: hash,
      content: content,
      refcount: 1
    }, metadata));
  }

  SandstormDb.prototype.addStaticAsset = addStaticAsset;

  SandstormDb.prototype.refStaticAsset = function (id) {
    // Increment the refcount on an existing static asset.
    //
    // You must call this BEFORE adding the new reference to the DB, in case of failure between
    // the two calls. (This way, the failure case is a storage leak, which is probably not a big
    // deal and can be fixed by GC, rather than a mysteriously missing asset.)

    check(id, String);

    var existing = StaticAssets.findAndModify({
      query: {hash: hash},
      update: {$inc: {refcount: 1}},
      fields: {_id: 1, refcount: 1},
    });
    if (!existing) {
      throw new Error("refStaticAsset() called on asset that doesn't exist");
    }
  }

  SandstormDb.prototype.unrefStaticAsset = function (id) {
    // Decrement refcount on a static asset and delete if it has reached zero.
    //
    // You must call this AFTER removing the reference from the DB, in case of failure between
    // the two calls. (This way, the failure case is a storage leak, which is probably not a big
    // deal and can be fixed by GC, rather than a mysteriously missing asset.)

    check(id, String);

    var existing = StaticAssets.findAndModify({
      query: {_id: id},
      update: {$inc: {refcount: -1}},
      fields: {_id: 1, refcount: 1},
      new: true,
    });
    if (!existing) {
      console.error(new Error("unrefStaticAsset() called on asset that doesn't exist").stack);
    } else if (existing.refcount <= 0) {
      StaticAssets.remove({_id: existing._id});
    }
  }

  SandstormDb.prototype.getStaticAsset = function (id) {
    // Get a static asset's mimeType, encoding, and raw content.

    check(id, String);

    var asset = StaticAssets.findOne(id, {fields: {_id: 0, mimeType: 1, encoding: 1, content: 1}});
    if (asset) {
      // TODO(perf): Mongo converts buffers to something else. Figure out a way to avoid a copy
      //   here.
      asset.content = new Buffer(asset.content);
    }
    return asset;
  }

  SandstormDb.prototype.newAssetUpload = function (purpose) {
    check(purpose, {profilePicture: {userId: DatabaseId, identityId: Match.Optional(DatabaseId)}});

    return AssetUploadTokens.insert({
      purpose: purpose,
      expires: new Date(Date.now() + 300000),  // in 5 minutes
    });
  }

  SandstormDb.prototype.fulfillAssetUpload = function (id) {
    // Indicates that the given asset upload has completed. It will be removed and its purpose
    // returned. If no matching upload exists, returns undefined.

    check(id, String);

    var upload = AssetUploadTokens.findAndModify({
      query: {_id: id},
      remove: true
    });

    if (upload.expires.valueOf() < Date.now()) {
      return undefined;  // already expired
    } else {
      return upload.purpose;
    }
  }

  function cleanupExpiredAssetUploads() {
    AssetUploadTokens.remove({expires: {$lt: Date.now()}});
  }

  // Cleanup tokens every hour, with a random phase.
  Meteor.setTimeout(function () {
    cleanupExpiredAssetUploads();
    Meteor.setInterval(function () {
      cleanupExpiredAssetUploads();
    }, 3600000);
  }, Math.floor(Math.random() * 3600000));
}
