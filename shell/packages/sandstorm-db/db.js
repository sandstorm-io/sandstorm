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

// Useful for debugging: Set the env variable LOG_MONGO_QUERIES to have the server write every
// query it makes, so you can see if it's doing queries too often, etc.
if (Meteor.isServer && process.env.LOG_MONGO_QUERIES) {
  const oldFind = Mongo.Collection.prototype.find;
  Mongo.Collection.prototype.find = function () {
    console.log(this._prefix, arguments);
    return oldFind.apply(this, arguments);
  };
}

// Helper so that we don't have to if (Meteor.isServer) before declaring indexes.
if (Meteor.isServer) {
  Mongo.Collection.prototype.ensureIndexOnServer = Mongo.Collection.prototype._ensureIndex;
} else {
  Mongo.Collection.prototype.ensureIndexOnServer = function () {};
}

// TODO(soon): Systematically go through this file and add ensureIndexOnServer() as needed.

const collectionOptions = { defineMutationMethods: Meteor.isClient };
// Set to `true` on the client so that method simulation works. Set to `false` on the server
// so that we can be extra certain that all mutations must go through methods.

// Users = new Mongo.Collection("users");
// The users collection is special and can be accessed through `Meteor.users`.
// See https://docs.meteor.com/#/full/meteor_users.
//
// There are two distinct types of entries in the users collection: identities and accounts. An
// identity contains personal profile information and typically includes some intrinsic method for
// authenticating as the owner of that information.
//
// An account is an owner of app actions, grains, contacts, notifications, and payment info.
// Each account can have multiple identities linked to it. To log in as an account you must first
// authenticate as one of its linked identities.
//
// Every user contains the following fields:
//   _id: Unique string ID. For accounts, this is random. For identities, this is the globally
//        stable SHA-256 ID of this identity, hex-encoded.
//   createdAt: Date when this entry was added to the collection.
//   lastActive: Date of the user's most recent interaction with this Sandstorm server.
//   services: Object containing login data used by Meteor authentication services.
//   expires: Date when this user should be deleted. Only present for demo users.
//   upgradedFromDemo: If present, the date when this user was upgraded from being a demo user.
//                     TODO(cleanup): Unlike other dates in our database, this is stored as a number
//                     rather than as a Date object. We should fix that.
//   appDemoId: If present and non-null, then the user is a demo user who arrived via an /appdemo/
//              link. This field contains the app ID of the app that the user started out demoing.
//              Unlike the `expires` field, this field is not cleared when the user upgrades from
//              being a demo user.
//   suspended: If this exists, this account/identity is supsended. Both accounts and identities
//              can be suspended. After some amount of time, the user will be completely deleted
//              and removed from the DB.
//              It is an object with fields:
//                voluntary: Boolean. This is true if the user initiated it. They will have the
//                  chance to still login and reverse the suspension/deletion.
//                admin: The userId of the admin who suspended the account.
//                timestamp: Date object. When the suspension occurred.
//                willDelete: Boolean. If true, this account will be deleted after some time.
//
// Identity users additionally contain the following fields:
//   profile: Object containing the data that will be shared with users and grains that come into
//            contact with this identity. Includes the following fields:
//       service: String containing the name of this identity's authentication method.
//       name: String containing the chosen display name of the identity.
//       handle: String containing the identity's preferred handle.
//       picture: _id into the StaticAssets table for the identity's picture. If not present,
//                an identicon will be used.
//       pronoun: One of "male", "female", "neutral", or "robot".
//   unverifiedEmail: If present, a string containing an email address specified by the user.
//   referredBy: ID of the Account that referred this Identity.
//
// Account users additionally contain the following fields:
//   loginIdentities: Array of identity objects, each of which may include the following fields.
//       id: The globally-stable SHA-256 ID of this identity, hex-encoded.
//   nonloginIdentities: Array of identity objects, of the same form as `loginIdentities`. We use
//                       a separate array here so that we can use a Mongo index to enforce the
//                       invariant that an identity only be a login identity for a single account.
//   primaryEmail: String containing this account's primary email address. Must be a verified adress
//                 of one of this account's linked identities. Call SandstormDb.getUserEmails()
//                 to do this checking automatically.
//   isAdmin: Boolean indicating whether this account is allowed to access the Sandstorm admin panel.
//   signupKey: If this is an invited user, then this field contains their signup key.
//   signupNote: If the user was invited through a link, then this field contains the note that the
//               inviter admin attached to the key.
//   signupEmail: If the user was invited by email, then this field contains the email address that
//                the invite was sent to.
//   hasCompletedSignup: True if this account has confirmed its profile and agreed to this server's
//                       terms of service.
//   plan: _id of an entry in the Plans table which determines the user's quota.
//   planBonus: {storage, compute, grains} bonus amounts to add to the user's plan. The payments
//              module writes data here; we merely read it. Missing fields should be treated as
//              zeroes. Does not yet include referral bonus, which is calculated separately.
//              TODO(cleanup): Use for referral bonus too.
//   storageUsage: Number of bytes this user is currently storing.
//   payments: Object defined by payments module, if loaded.
//   dailySentMailCount: Number of emails sent by this user today; used to limit spam.
//   accessRequests: Object containing the following fields; used to limit spam.
//       count: Number of "request access" emails during sent during the current interval.
//       resetOn: Date when the count should be reset.
//   referredByComplete: ID of the Account that referred this Account. If this is set, we
//                        stop writing new referredBy values onto Identities for this account.
//   referredCompleteDate: The Date at which the completed referral occurred.
//   referredIdentityIds: List of Identity IDs that this Account has referred. This is used for
//                        reliably determining which Identity's names are safe to display.
//   experiments: Object where each field is an experiment that the user is in, and each value
//           is the parameters for that experiment. Typically, the value simply names which
//           experiment group which the user is in, where "control" is one group. If an experiment
//           is not listed, then the user should not be considered at all for the purpose of that
//           experiment. Each experiment may define a point in time where users not already in the
//           experiment may be added to it and assigned to a group (for example, at user creation
//           time). Current experiments:
//       firstTimeBillingPrompt: Value is "control" or "test". Users are assigned to groups at
//               account creation on servers where billing is enabled (i.e. Oasis). Users in the
//               test group will see a plan selection dialog and asked to make an explitic choice
//               (possibly "free") before they can create grains (but not when opening someone
//               else's shared grain). The goal of the experiment is to determine whether this
//               prompt scares users away -- and also whether it increases paid signups.
//   stashedOldUser: A complete copy of this user from before the accounts/identities migration.
//                   TODO(cleanup): Delete this field once we're sure it's safe to do so.

Meteor.users.ensureIndexOnServer("services.google.email", { sparse: 1 });
Meteor.users.ensureIndexOnServer("services.github.emails.email", { sparse: 1 });
Meteor.users.ensureIndexOnServer("services.email.email", { unique: 1, sparse: 1 });
Meteor.users.ensureIndexOnServer("loginIdentities.id", { unique: 1, sparse: 1 });
Meteor.users.ensureIndexOnServer("nonloginIdentities.id", { sparse: 1 });
Meteor.users.ensureIndexOnServer("services.google.id", { unique: 1, sparse: 1 });
Meteor.users.ensureIndexOnServer("services.github.id", { unique: 1, sparse: 1 });
Meteor.users.ensureIndexOnServer("suspended.willDelete", { sparse: 1 });

// TODO(cleanup): This index is obsolete; delete it.
Meteor.users.ensureIndexOnServer("identities.id", { unique: 1, sparse: 1 });

Packages = new Mongo.Collection("packages", collectionOptions);
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
//   shouldCleanup:  If true, a reference to this package was recently dropped, and the package
//       collector should at some point check whether there are any other references and, if not,
//       delete the package.
//   url:  When status is "download", the URL from which the SPK can be obtained, if provided.
//   isAutoUpdated: This package was downloaded as part of an auto-update. We shouldn't clean it up
//     even if it has no users.
//   authorPgpKeyFingerprint: Verified PGP key fingerprint (SHA-1, hex, all-caps) of the app
//     packager.

DevPackages = new Mongo.Collection("devpackages", collectionOptions);
// List of packages currently made available via the dev tools running on the local machine.
// This is normally empty; the only time it is non-empty is when a developer is using the spk tool
// on the local machine to publish an under-development app to this server. That should only ever
// happen on developers' desktop machines.
//
// While a dev package is published, it automatically appears as installed by every user of the
// server, and it overrides all packages with the same application ID. If any instances of those
// packages are currently open, they are killed and reset on publish.
//
// When the dev tool disconnects, the package is automatically unpublished, and any open instances
// are again killed and refreshed.
//
// Each contains:
//   _id:  The package ID string (as with Packages._id).
//   appId: The app ID this package is intended to override (as with Packages.appId).
//   timestamp:  Time when the package was last updated. If this changes while the package is
//     published, all running instances are reset. This is used e.g. to reset the app each time
//     changes are made to the source code.
//   manifest:  The app's manifest, as with Packages.manifest.
//   mountProc: True if the supervisor should mount /proc.

UserActions = new Mongo.Collection("userActions", collectionOptions);
// List of actions that each user has installed which create new grains.  Each app may install
// some number of actions (usually, one).
//
// Each contains:
//   _id:  random
//   userId:  Account ID of the user who has installed this action.
//   packageId:  Package used to run this action.
//   appId:  Same as Packages.findOne(packageId).appId; denormalized for searchability.
//   appTitle:  Same as Packages.findOne(packageId).manifest.appTitle; denormalized so
//       that clients can access it without subscribing to the Packages collection.
//   appVersion:  Same as Packages.findOne(packageId).manifest.appVersion; denormalized for
//       searchability.
//   appMarketingVersion:  Human-readable presentation of the app version, e.g. "2.9.17"
//   title: JSON-encoded LocalizedText title for this action, e.g.
//       `{defaultText: "New Spreadsheet"}`.
//   nounPhrase: JSON-encoded LocalizedText describing what is created when this action is run.
//   command:  Manifest.Command to run this action (see package.capnp).

Grains = new Mongo.Collection("grains", collectionOptions);
// Grains belonging to users.
//
// Each contains:
//   _id:  random
//   packageId:  _id of the package of which this grain is an instance.
//   packageSalt: If present, a random string that will used in session ID generation. This field
//       is usually updated when `packageId` is updated, triggering automatic refreshes for
//       clients with active sessions.
//   appId:  Same as Packages.findOne(packageId).appId; denormalized for searchability.
//   appVersion:  Same as Packages.findOne(packageId).manifest.appVersion; denormalized for
//       searchability.
//   userId: The _id of the account that owns this grain.
//   identityId: The identity with which the owning account prefers to open this grain.
//   title:  Human-readable string title, as chosen by the user.
//   lastUsed:  Date when the grain was last used by a user.
//   private: If true, then knowledge of `_id` does not suffice to open this grain.
//   cachedViewInfo: The JSON-encoded result of `UiView.getViewInfo()`, cached from the most recent
//                   time a session to this grain was opened.
//   trashed: If present, the Date when this grain was moved to the trash bin. Thirty days after
//            this date, the grain will be automatically deleted.
//   suspended: If true, the owner of this grain has been suspended. They will soon be deleted,
//              so treat this grain the same as "trashed". It is denormalized out of Users for ease
//              of querying.
//   ownerSeenAllActivity: True if the owner has viewed the grain since the last activity event
//       occurred. See also ApiTokenOwner.user.seenAllActivity.
//   size: On-disk size of the grain in bytes.
//
// The following fields *might* also exist. These are temporary hacks used to implement e-mail and
// web publishing functionality without powerbox support; they will be replaced once the powerbox
// is implemented.
//   publicId:  An id used to publicly identify this grain. Used e.g. to route incoming e-mail and
//       web publishing. This field is initialized when first requested by the app.

RoleAssignments = new Mongo.Collection("roleAssignments", collectionOptions);
// *OBSOLETE* Before `user` was a variant of ApiTokenOwner, this collection was used to store edges
// in the permissions sharing graph. This functionality has been subsumed by the ApiTokens
// collection.

Contacts = new Mongo.Collection("contacts", collectionOptions);
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
//   ownerId: The accountId of the user account who owns this contact.
//   petname: Human-readable label chosen by and only visible to the owner. Uniquely identifies
//            the contact to the owner.
//   created: Date when this contact was created.
//   identityId: The `_id` of the user whose contact info this contains.

Sessions = new Mongo.Collection("sessions", collectionOptions);
// UI sessions open to particular grains.  A new session is created each time a user opens a grain.
//
// Each contains:
//   _id:  String generated as a SHA256 hash of the grain ID, the user ID, a salt generated by the
//       client, and the grain's `packageSalt`.
//   grainId:  _id of the grain to which this session is connected.
//   hostId: ID part of the hostname from which this grain is being served. I.e. this replaces the
//       '*' in WILDCARD_HOST.
//   tabId: Random value unique to the grain tab in which this session is displayed. Typically
//       every session has a different `tabId`, but embedded sessions (including in the powerbox)
//       have the same `tabId` as the outer session.
//   timestamp:  Time of last keep-alive message to this session.  Sessions time out after some
//       period.
//   userId:  Account ID of the user who owns this session.
//   identityId:  Identity ID of the user who owns this session.
//   hashedToken: If the session is owned by an anonymous user, the _id of the entry in ApiTokens
//       that was used to open it. Note that for old-style sharing (i.e. when !grain.private),
//       anonymous users can get access without an API token and so neither userId nor hashedToken
//       are present.
//   powerboxView: If present, this is a view that should be presented as part of a powerbox
//       interaction.
//     offer: The webkey that corresponds to cap that was passed to the `offer` RPC.
//   viewInfo: The UiView.ViewInfo corresponding to the underlying UiSession. This isn't populated
//       until newSession is called on the UiView.
//   permissions: The permissions for the current identity on this UiView. This isn't populated
//       until newSession is called on the UiView.
//   hasLoaded: Marked as true by the proxy when the underlying UiSession has responded to its first
//       request

SignupKeys = new Mongo.Collection("signupKeys", collectionOptions);
// Invite keys which may be used by users to get access to Sandstorm.
//
// Each contains:
//   _id:  random
//   used:  Boolean indicating whether this key has already been consumed.
//   note:  Text note assigned when creating key, to keep track of e.g. whom the key was for.
//   email: If this key was sent as an email invite, the email address to which it was sent.

ActivityStats = new Mongo.Collection("activityStats", collectionOptions);
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
//   demoUsers: Demo users.
//   appDemoUsers: Users that came in through "app demo".
//   activeGrains: The number of unique grains that have been used in the time interval.
//   apps: An object indexed by app ID recording, for each app:
//       owners: Number of unique owners of this app (counting only grains that still exist).
//       sharedUsers: Number of users who have accessed other people's grains of this app (counting
//         only grains that still exist).
//       grains: Number of active grains of this app (that still exist).
//       deleted: Number of non-demo grains of this app that were deleted.
//       demoed: Number of demo grains created and expired.
//       appDemoUsers: Number of app demos initiated with this app.

DeleteStats = new Mongo.Collection("deleteStats", collectionOptions);
// Contains records of objects that were deleted, for stat-keeping purposes.
//
// Each contains:
//   type: "grain" or "user" or "demoGrain" or "demoUser" or "appDemoUser"
//   lastActive: Date of the user's or grain's last activity.
//   appId: For type = "grain", the app ID of the grain. For type = "appDemoUser", the app ID they
//     arrived to demo. For others, undefined.

FileTokens = new Mongo.Collection("fileTokens", collectionOptions);
// Tokens corresponding to backup files that are currently stored on the server. A user receives
// a token when they create a backup file (either by uploading it, or by backing up one of their
// grains) and may use the token to read the file (either to download it, or to restore a new
// grain from it).
//
// Each contains:
//   _id:       The unguessable token string.
//   name:      Suggested filename.
//   timestamp: File creation time. Used to figure out when the token and file should be wiped.

ApiTokens = new Mongo.Collection("apiTokens", collectionOptions);
// Access tokens for APIs exported by apps.
//
// Originally API tokens were only used by external users through the HTTP API endpoint. However,
// now they are also used to implement SturdyRefs, not just held by external users, but also when
// an app holds a SturdyRef to another app within the same server. See the various `save()`,
// `restore()`, and `drop()` methods in `grain.capnp` (on `SandstormApi`, `AppPersistent`, and
// `MainView`) -- the fields of type `Data` are API tokens.
//
// Each contains:
//   _id:       A SHA-256 hash of the token, base64-encoded.
//   grainId:   The grain servicing this API. (Not present if the API isn't serviced by a grain.)
//   identityId: For UiView capabilities, this is the identity for which the view is attenuated.
//              That is, the UiView's newSession() method will intersect the requested permissions
//              with this identity's permissions before forwarding on to the underlying app. If
//              `identityId` is not present, then no identity attenuation is applied, i.e. this is
//              a raw UiView as implemented by the app. (The `roleAssignment` field, below, may
//              still apply. For non-UiView capabilities, `identityId` is never present. Note that
//              this is NOT the identity against which the `requiredPermissions` parameter of
//              `SandstormApi.restore()` is checked; that would be `owner.grain.introducerIdentity`.
//   accountId: For tokens where `identityId` is set, the `_id` (in the Users table) of the account
//              that created the token.
//   roleAssignment: If this API token represents a UiView, this field contains a JSON-encoded
//              Grain.ViewSharingLink.RoleAssignment representing the permissions it carries. These
//              permissions will be intersected with those held by `identityId` when the view is
//              opened.
//   forSharing: If true, requests sent to the HTTP API endpoint with this token will be treated as
//              anonymous rather than as directly associated with `identityId`. This has no effect
//              on the permissions granted.
//   objectId:  If present, this token represents an arbitrary Cap'n Proto capability exported by
//              the app or its supervisor (whereas without this it strictly represents UiView).
//              sturdyRef is the JSON-encoded SupervisorObjectId (defined in `supervisor.capnp`).
//              Note that if the SupervisorObjectId contains an AppObjectId, that field is
//              treated as type AnyPointer, and so encoded as a raw Cap'n Proto message.
//   frontendRef: If present, this token actually refers to an object implemented by the front-end,
//              not a particular grain. (`grainId` and `identityId` are not set.) This is an object
//              containing exactly one of the following fields:
//       notificationHandle: A `Handle` for an ongoing notification, as returned by
//                           `NotificationTarget.addOngoing`. The value is an `_id` from the
//                           `Notifications` collection.
//       ipNetwork: An IpNetwork capability that is implemented by the frontend. Eventually, this
//                  will be moved out of the frontend and into the backend, but we'll migrate the
//                  database when that happens. This field contains the boolean true to signify that
//                  it has been set.
//       ipInterface: Ditto IpNetwork, except it's an IpInterface.
//       emailVerifier: An EmailVerifier capability that is implemented by the frontend. The
//                      value is an object containing the fields `id` and `services`. `id` is the
//                      value returned by `EmailVerifier.getId()` and is used as part of a
//                      powerbox query for matching verified emails. `services` is a
//                      list of names of identity providers that are trusted to verify addresses.
//                      If `services` is omitted or falsy, all configured identity providers are
//                      trusted. Note that a malicious user could specify invalid names in the
//                      list; they should be ignored.
//       verifiedEmail: An VerifiedEmail capability that is implemented by the frontend.
//                      An object containing `verifierId`, `tabId`, and `address`.
//       identity: An Identity capability. The field is the identity ID.
//   parentToken: If present, then this token represents exactly the capability represented by
//              the ApiToken with _id = parentToken, except possibly (if it is a UiView) attenuated
//              by `roleAssignment` (if present). To facilitate permissions computations, if the
//              capability is a UiView, then `grainId` is set to the backing grain, `identityId`
//              is set to the identity that shared the view, and `accountId` is set to the account
//              that shared the view. Neither `objectId` nor `frontendRef` is present when
//              `parentToken` is present.
//   petname:   Human-readable label for this access token, useful for identifying tokens for
//              revocation. This should be displayed when visualizing incoming capabilities to
//              the grain identified by `grainId`.
//   created:   Date when this token was created.
//   revoked:   If true, then this sturdyref has been revoked and can no longer be restored. It may
//              become un-revoked in the future.
//   trashed:   If present, the Date when this token was moved to the trash bin. Thirty days after
//              this date, the token will be automatically deleted.
//   suspended: If true, the owner of this token has been suspended. They will soon be deleted,
//              so treat this token the same as "trashed". It is denormalized out of Users for
//              ease of querying.
//   expires:   Optional expiration Date. If undefined, the token does not expire.
//   lastUsed:  Optional Date when this token was last used.
//   owner:     A `ApiTokenOwner` (defined in `supervisor.capnp`, stored as a JSON object)
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
//   hasApiHost: If true, there is an entry in ApiHosts for this token, which will need to be
//              cleaned up when the token is.
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
//           identityId :Text;
//           roleAssignment :RoleAssignment;
//           forSharing :Bool;
//         }
//         objectId :SupervisorObjectId;
//       }
//     }
//     frontendRef :union {
//       notificationHandle :Text;
//       ipNetwork :Bool;
//       ipInterface :Bool;
//       emailVerifier :group {
//         id :Text;
//         services :List(String);
//       }
//       verifiedEmail :group {
//         verifierId :Text;
//         tabId :Text;
//         address :Text;
//       }
//       identity :Text;
//     }
//     child :group {
//       parentToken :Text;
//       union {
//         uiView :group {
//           grainId :Text;
//           identityId :Text;
//           roleAssignment :RoleAssignment = (allAccess = ());
//         }
//         other :Void;
//       }
//     }
//   }
//   requirements: List(Supervisor.MembraneRequirement);
//   ...
// }

ApiTokens.ensureIndexOnServer("grainId", { sparse: 1 });
ApiTokens.ensureIndexOnServer("owner.user.identityId", { sparse: 1 });
ApiTokens.ensureIndexOnServer("frontendRef.emailVerifier.id", { sparse: 1 });

ApiHosts = new Mongo.Collection("apiHosts", collectionOptions);
// Allows defining some limited static behavior for an API host when accessed unauthenticated. This
// mainly exists to allow backwards-compatibility with client applications that expect to be able
// to probe an API host without authentication to determine capabilities such as DAV protocols
// supported, before authenticating to perform real requests. An app can specify these properties
// when creating an offerTemplate.
//
// Each contains:
//   _id:          apiHostIdHashForToken() of the corresponding API token.
//   hash2:        hash(hash(token)), aka hash(ApiToken._id). Used to allow ApiHosts to be cleaned
//                 up when ApiTokens are deleted.
//   options:      Specifies how to respond to unauthenticated OPTIONS requests on this host.
//                 This is an object containing fields:
//     dav:        List of strings specifying DAV header `compliance-class`es, e.g. "1" or
//                 "calendar-access". https://tools.ietf.org/html/rfc4918#section-10.1
//   resources:    Object mapping URL paths (including initial '/') to static HTTP responses to
//                 give when those paths are accessed unauthenticated. Due to Mongo disliking '.'
//                 and '$' in keys, these characters must be escaped as '\uFF0E' and '\uFF04'
//                 (see SandstormDb.escapeMongoKey). Each value in this map is an object with
//                 fields:
//     type:       Content-Type.
//     language:   Content-Language.
//     encoding:   Content-Encoding.
//     body:       Entity-body as a string or buffer.

Notifications = new Mongo.Collection("notifications", collectionOptions);
// Notifications for a user.
//
// Each contains:
//   _id:          random
//   grainId:      The grain originating this notification, if any.
//   userId:       Account ID of the user receiving the notification.
//   text:         The JSON-ified LocalizedText to display in the notification.
//   isUnread:     Boolean indicating if this notification is unread.
//   timestamp:    Date when this notification was last updated
//   eventType:    If this notification is due to an activity event, this is the numeric index
//                 of the event type on the grain's ViewInfo.
//   count:        The number of times this exact event has repeated. Identical events are
//                 aggregated by incrementing the count.
//   initiatingIdentity: Identity ID of the user who initiated this notification.
//   initiatorAnonymous: True if the initiator is an anonymous user. If neither this nor
//                 initiatingIdentity is present, the notification is not from a user.
//   path:         Path inside the grain to which the user should be directed if they click on
//                 the notification.
//   ongoing:      If present, this is an ongoing notification, and this field contains an
//                 ApiToken referencing the `OngoingNotification` capability.
//   admin:        If present, this is a notification intended for an admin.
//     action:     If present, this is a (string) link that the notification should direct the
//                 admin to.
//     type:       The type of notification -- can be "reportStats", "cantRenewFeatureKey", or
//                 "trialFeatureKeyExpired".
//   appUpdates:   If present, this is an app update notification. It is an object with the appIds
//                 as keys.
//     $appId:     The appId that has an outstanding update.
//       packageId: The packageId that it will update to.
//       name: The name of the app. (appTitle from package.manifest)
//       version: The app's version number. (appVersion from package.manifest)
//       marketingVersion: String marketing version of this app. (appMarketingVersion from package.manifest)
//   referral:     If this boolean field is true, then treat this notification as a referral
//                 notification. This causes text to be ignored, since we need custom logic.
//   mailingListBonus: Like `referral`, but notify the user about the mailing list bonus. This is
//                 a one-time notification only to Oasis users who existed when the bonus program
//                 was implemented.

ActivitySubscriptions = new Mongo.Collection("activitySubscriptions", collectionOptions);
// Activity events to which a user is subscribed.
//
// Each contains:
//   _id:          random
//   identityId:   Who is subscribed.
//   grainId:      Grain to which subscription applies.
//   threadPath:   If present, the subscription is on a specific thread. Otherwise, it is on the
//                 whole grain.
//   mute:         If true, this is an anti-subscription -- matching events should NOT notify.
//                 This allows is useful to express:
//                 - A user wants to subscribe to a grain but mute a specific thread.
//                 - The owner of a grain does not want notifications (normally, they are
//                   implicitly subscribed).
//                 - A user no longer wishes to be implicitly subscribed to threads in a grain on
//                   which they comment, so they mute the grain.

ActivitySubscriptions.ensureIndexOnServer("identityId");
ActivitySubscriptions.ensureIndexOnServer({ "grainId": 1, "threadPath": 1 });

StatsTokens = new Mongo.Collection("statsTokens", collectionOptions);
// Access tokens for the Stats collection
//
// These tokens are used for accessing the ActivityStats collection remotely
// (ie. from a dashboard webapp)
//
// Each contains:
//   _id:       The token. At least 128 bits entropy (Random.id(22)).

Misc = new Mongo.Collection("misc", collectionOptions);
// Miscellaneous configuration and other settings
//
// This table is currently only used for persisting BASE_URL from one session to the next,
// but in general any miscellaneous settings should go in here
//
// Each contains:
//   _id:       The name of the setting. eg. "BASE_URL"
//   value:     The value of the setting.

Settings = new Mongo.Collection("settings", collectionOptions);
// Settings for this Sandstorm instance go here. They are configured through the adminSettings
// route. This collection differs from misc in that any admin user can update it through the admin
// interface.
//
// Each contains:
//   _id:       The name of the setting. eg. "smtpConfig"
//   value:     The value of the setting.
//   automaticallyReset: Sometimes the server needs to automatically reset a setting. When it does
//                       so, it will also write an object to this field indicating why the reset was
//                       needed. That object can have the following variants:
//       baseUrlChangedFrom: The reset was due to BASE_URL changing. This field contains a string
//                           with the old BASE_URL.
//   preinstalledApps: A list of objects:
//     appId: The Packages.appId of the app to install
//     status: packageId
//     packageId: The Packages._id of the app to install
//
//   potentially other fields that are unique to the setting

Migrations = new Mongo.Collection("migrations", collectionOptions);
// This table tracks which migrations we have applied to this instance.
// It contains a single entry:
//   _id:       "migrations_applied"
//   value:     The number of migrations this instance has successfully completed.

StaticAssets = new Mongo.Collection("staticAssets", collectionOptions);
// Collection of static assets served up from the Sandstorm server's "static" host. We only
// support relatively small assets: under 1MB each.
//
// Each contains:
//   _id:       Random ID; will be used in the URL.
//   hash:      A base64-encoded SHA-256 hash of the data, used to de-dupe.
//   mimeType:  MIME type of the asset, suitable for Content-Type header.
//   encoding:  Either "gzip" or not present, suitable for Content-Encoding header.
//   content:   The asset content (byte buffer).
//   refcount:  Number of places where this asset's ID appears in the database. Since Mongo doesn't
//       have transactions, this needs to bias towards over-counting; a backup GC could be used
//       to catch leaked assets, although it's probably not a big deal in practice.

AssetUploadTokens = new Mongo.Collection("assetUploadTokens", collectionOptions);
// Collection of tokens representing a single-use permission to upload an asset, such as a new
// profile picture.
//
// Each contains:
//   _id:       Random ID.
//   purpose:   Contains one of the following, indicating how the asset is to be used:
//       profilePicture: Indicates that the upload is a new profile picture. Contains fields:
//           userId: Account ID of user whose picture shall be replaced.
//           identityId: Which of the user's identities shall be updated.
//   expires:   Time when this token will go away if unused.

Plans = new Mongo.Collection("plans", collectionOptions);
// Subscription plans, which determine quota.
//
// Each contains:
//   _id: Plan ID, usually a short string like "free", "standard", "large", "mega", ...
//   storage: Number of bytes this user is allowed to store.
//   compute: Number of kilobyte-RAM-seconds this user is allowed to consume.
//   computeLabel: Label to display to the user describing this plan's compute units.
//   grains: Total number of grains this user can create (often `Infinity`).
//   price: Price per month in US cents.
//   hidden: If true, a user cannot switch to this plan, but some users may be on it and are
//       allowed to switch away.
//   title: Title from display purposes. If missing, default to capitalizing _id.

AppIndex = new Mongo.Collection("appIndex", collectionOptions);
// A mirror of the data from the App Market index
//
// Each contains:
//   _id: the appId of the app
//  The rest of the fields are defined in src/sandstorm/app-index/app-index.capnp:AppIndexForMarket

KeybaseProfiles = new Mongo.Collection("keybaseProfiles", collectionOptions);
// Cache of Keybase profile information. The profile for a user is re-fetched every time a package
// by that user is installed, as well as if the keybase profile is requested and not already
// present for some reason.
//
// Each contains:
//   _id: PGP key fingerprint (SHA-1, hex, all-caps)
//   displayName: Display name from Keybase. (NOT VERIFIED AT ALL.)
//   handle: Keybase handle.
//   proofs: The "proofs_summary.all" array from the Keybase lookup. See the non-existent Keybase
//     docs for details. We also add a boolean "status" field to each proof indicating whether
//     we have directly verified the proof ourselves. Its values may be "unverified" (Keybase
//     returned this but we haven't checked it directly), "verified" (we verified the proof and it
//     is valid), "invalid" (we checked the proof and it was definitely bogus), or "checking" (the
//     server is currently actively checking this proof). Note that if a check fails due to network
//     errors, the status goes back to "unverified".
//
//     WARNING: Currently verification is NOT IMPLEMENTED, so all proofs will be "unverified"
//       for now and we just trust Keybase.

FeatureKey = new Mongo.Collection("featureKey", collectionOptions);
// Responsible for storing the current feature key that is active on the server.  Contains a single
// document with two keys:
//
//   _id: "currentFeatureKey"
//   value: the still-signed, binary-encoded feature key
//          (a feature key with comments removed and base64 decoded)
//   renewalProblem: If we tried to renew this feature key and failed, an object describing that
//       failure. Includes exactly one of the following fields:
//     noPaymentSource: True, indicating that the key could not be renewed because there was no
//         payment source set for this key.
//     paymentFailed: String error message returned by our payment processor describing why they
//         declined the charge.
//     noSuchKey: True, indicating the key doesn't exist.
//     revoked: True, indicating the key has been revoked.
//     unknownResponse: String response text from the renewal API which wasn't recognized. Should
//         be reported to Sandstorm.
//     exception: String error message from an exception thrown by the renewal code. This usually
//         indicates some sort of connectivity problem, so could be reported to the user as:
//         "There was a problem reaching the feature key renewal server."
//
// This is only intended to be visible on the server.

SetupSession = new Mongo.Collection("setupSession", collectionOptions);
// Responsible for storing information about setup sessions.  Contains a single document with three
// keys:
//
//   _id: "current-session"
//   creationDate: Date object indicating when this session was created.
//   hashedSessionId: the sha256 of the secret session id that was returned to the client

const DesktopNotifications = new Mongo.Collection("desktopNotifications", collectionOptions);
// Responsible for very short-lived queueing of desktop notification information.
// Entries are removed when they are ~30 seconds old.  This collection is a bit
// odd in that it is intended primarily for edge-triggered communications, but
// Meteor's collections aren't really designed to support that organization.
// Fields for each :
//
//   _id: String.  Used as the tag to coordinate notification merging between browser tabs.
//   creationDate: Date object. indicating when this notification was posted.
//   userId: String. Account id to which this notification was published.
//   notificationId: String.  ID of the matching event in the Notifications table to dismiss if this
//                            notification is activated.
//   appActivity: Object with fields:
//     user: Optional Object. Not present if this notification wasn't generated by a user. If
//           present, it will have one of the following shapes:
//       { anonymous: true } if this notification was generated by an anonymous user.  Otherwise:
//       {
//         identityId: String  The user's identity ID.
//         name: String        The user's display name.
//         avatarUrl: String   The URL for the user's profile picture.
//       },
//     grainId: String,      Which grain this action took place on
//     path: String,         The path of the notification.
//     body: Util.LocalizedText,  The main body of the activity event.
//     actionText: Util.LocalizedText, What action the user took, e.g.
//                                     { defaultText: "added a comment" }

if (Meteor.isServer) {
  Meteor.publish("credentials", function () {
    // Data needed for isSignedUp() and isAdmin() to work.

    if (this.userId) {
      const db = this.connection.sandstormDb;
      return [
        Meteor.users.find({ _id: this.userId },
            { fields: { signupKey: 1, isAdmin: 1, expires: 1, storageUsage: 1,
                      plan: 1, planBonus: 1, hasCompletedSignup: 1, experiments: 1,
                      referredIdentityIds: 1, cachedStorageQuota: 1, suspended: 1, }, }),
        db.collections.plans.find(),
      ];
    } else {
      return [];
    }
  });
}

const countReferrals = function (user) {
  const referredIdentityIds = user.referredIdentityIds;
  return (referredIdentityIds && referredIdentityIds.length || 0);
};

const calculateReferralBonus = function (user) {
  // This function returns an object of the form:
  //
  // - {grains: 0, storage: 0}
  //
  // which are extra resources this account gets as part of participating in the referral
  // program. (Storage is measured in bytes, as usual for plans.)

  // TODO(cleanup): Consider moving referral bonus logic into Oasis payments module (since it's
  //   payments-specific) and aggregating into `planBonus`.

  // Authorization note: Only call this if accountId is the current user!
  const isPaid = (user.plan && user.plan !== "free");

  successfulReferralsCount = countReferrals(user);
  if (isPaid) {
    const maxPaidStorageBonus = 30 * 1e9;
    return { grains: 0,
            storage: Math.min(
              successfulReferralsCount * 2 * 1e9,
              maxPaidStorageBonus), };
  } else {
    const maxFreeStorageBonus = 2 * 1e9;
    const bonus = {
      storage: Math.min(
        successfulReferralsCount * 50 * 1e6,
        maxFreeStorageBonus),
    };
    if (successfulReferralsCount > 0) {
      bonus.grains = Infinity;
    } else {
      bonus.grains = 0;
    }

    return bonus;
  }
};

isAdmin = function () {
  // Returns true if the user is the administrator.

  const user = Meteor.user();
  if (user && user.isAdmin) {
    return true;
  } else {
    return false;
  }
};

isAdminById = function (id) {
  // Returns true if the user's id is the administrator.

  const user = Meteor.users.findOne({ _id: id }, { fields: { isAdmin: 1 } });
  if (user && user.isAdmin) {
    return true;
  } else {
    return false;
  }
};

findAdminUserForToken = function (token) {
  if (!token.requirements) {
    return;
  }

  const requirements = token.requirements.filter(function (requirement) {
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

const wildcardHost = Meteor.settings.public.wildcardHost.toLowerCase().split("*");

if (wildcardHost.length != 2) {
  throw new Error("Wildcard host must contain exactly one asterisk.");
}

matchWildcardHost = function (host) {
  // See if the hostname is a member of our wildcard. If so, extract the ID.

  // We remove everything after the first ":" character so that our
  // comparison logic ignores port numbers.
  const prefix = wildcardHost[0];
  const suffix = wildcardHost[1].split(":")[0];
  const hostSansPort = host.split(":")[0];

  if (hostSansPort.lastIndexOf(prefix, 0) >= 0 &&
      hostSansPort.indexOf(suffix, -suffix.length) >= 0 &&
      hostSansPort.length >= prefix.length + suffix.length) {
    const id = hostSansPort.slice(prefix.length, -suffix.length);
    if (id.match(/^[-a-z0-9]*$/)) {
      return id;
    }
  }

  return null;
};

makeWildcardHost = function (id) {
  return wildcardHost[0] + id + wildcardHost[1];
};

const isApiHostId = function (hostId) {
  if (hostId) {
    const split = hostId.split("-");
    if (split[0] === "api") return split[1] || "*";
  }

  return false;
};

const isTokenSpecificHostId = function (hostId) {
  return hostId.lastIndexOf("api-", 0) === 0;
};

let apiHostIdHashForToken;
if (Meteor.isServer) {
  const Crypto = Npm.require("crypto");
  apiHostIdHashForToken = function (token) {
    // Given an API token, compute the host ID that must be used when requesting this token.

    // We add a leading 'x' to the hash so that knowing the hostname alone is not sufficient to
    // find the corresponding API token in the ApiTokens table (whose _id values are also hashes
    // of tokens). This doesn't technically add any security, but helps prove that we don't have
    // any bugs which would allow someone who knows only the hostname to access the app API.
    return Crypto.createHash("sha256").update("x" + token).digest("hex").slice(0, 32);
  };
} else {
  apiHostIdHashForToken = function (token) {
    // Given an API token, compute the host ID that must be used when requesting this token.

    // We add a leading 'x' to the hash so that knowing the hostname alone is not sufficient to
    // find the corresponding API token in the ApiTokens table (whose _id values are also hashes
    // of tokens). This doesn't technically add any security, but helps prove that we don't have
    // any bugs which would allow someone who knows only the hostname to access the app API.
    return SHA256("x" + token).slice(0, 32);
  };
}

const apiHostIdForToken = function (token) {
  return "api-" + apiHostIdHashForToken(token);
};

const makeApiHost = function (token) {
  return makeWildcardHost(apiHostIdForToken(token));
};

if (Meteor.isServer) {
  const Url = Npm.require("url");
  getWildcardOrigin = function () {
    // The wildcard URL can be something like "foo-*-bar.example.com", but sometimes when we're
    // trying to specify a pattern matching hostnames (say, a Content-Security-Policy directive),
    // an astrisk is only allowed as the first character and must be followed by a period. So we need
    // "*.example.com" instead -- which matches more than we actually want, but is the best we can
    // really do. We also add the protocol to the front (again, that's what CSP wants).

    // TODO(cleanup): `protocol` is computed in other files, like proxy.js. Put it somewhere common.
    const protocol = Url.parse(process.env.ROOT_URL).protocol;

    const dotPos = wildcardHost[1].indexOf(".");
    if (dotPos < 0) {
      return protocol + "//*";
    } else {
      return protocol + "//*" + wildcardHost[1].slice(dotPos);
    }
  };
}

SandstormDb = function (quotaManager) {
  // quotaManager is an object with the following method:
  //   updateUserQuota: It is provided two arguments
  //     db: This SandstormDb object
  //     user: A collections.users account object
  //   and returns a quota object:
  //     storage: A number (can be Infinity)
  //     compute: A number (can be Infinity)
  //     grains: A number (can be Infinity)

  this.quotaManager = quotaManager;
  this.collections = {
    // Direct access to underlying collections. DEPRECATED, but better than accessing the top-level
    // collection globals directly.
    //
    // TODO(cleanup): Over time, we will provide methods covering each supported query and remove
    //   direct access to the collections.
    users: Meteor.users,

    packages: Packages,
    devPackages: DevPackages,
    userActions: UserActions,
    grains: Grains,
    roleAssignments: RoleAssignments, // Deprecated, only used by the migration that eliminated it.
    contacts: Contacts,
    sessions: Sessions,
    signupKeys: SignupKeys,
    activityStats: ActivityStats,
    deleteStats: DeleteStats,
    fileTokens: FileTokens,
    apiTokens: ApiTokens,
    apiHosts: ApiHosts,
    notifications: Notifications,
    activitySubscriptions: ActivitySubscriptions,
    statsTokens: StatsTokens,
    misc: Misc,
    settings: Settings,
    migrations: Migrations,
    staticAssets: StaticAssets,
    assetUploadTokens: AssetUploadTokens,
    plans: Plans,
    appIndex: AppIndex,
    keybaseProfiles: KeybaseProfiles,
    featureKey: FeatureKey,
    setupSession: SetupSession,
    desktopNotifications: DesktopNotifications,
  };
};

// TODO(cleanup): These methods should not be defined freestanding and should use collection
//   objects created in SandstormDb's constructor rather than globals.

_.extend(SandstormDb.prototype, {
  isAdmin: isAdmin,
  isAdminById: isAdminById,
  findAdminUserForToken: findAdminUserForToken,
  matchWildcardHost: matchWildcardHost,
  makeWildcardHost: makeWildcardHost,
  isApiHostId: isApiHostId,
  isTokenSpecificHostId: isTokenSpecificHostId,
  apiHostIdHashForToken: apiHostIdHashForToken,
  apiHostIdForToken: apiHostIdForToken,
  makeApiHost: makeApiHost,
  allowDevAccounts() {
    const setting = this.collections.settings.findOne({ _id: "devAccounts" });
    if (setting) {
      return setting.value;
    } else {
      return Meteor.settings && Meteor.settings.public &&
             Meteor.settings.public.allowDevAccounts;
    }
  },

  roleAssignmentPattern: {
    none: Match.Optional(null),
    allAccess: Match.Optional(null),
    roleId: Match.Optional(Match.Integer),
    addPermissions: Match.Optional([Boolean]),
    removePermissions: Match.Optional([Boolean]),
  },

  isDemoUser() {
    // Returns true if this is a demo user.

    const user = Meteor.user();
    if (user && user.expires) {
      return true;
    } else {
      return false;
    }
  },

  isSignedUp() {
    const user = Meteor.user();
    return this.isAccountSignedUp(user);
  },

  isAccountSignedUp(user) {
    // Returns true if the user has presented an invite key.

    if (!user) return false;  // not signed in

    if (!user.loginIdentities) return false;  // not an account

    if (user.expires) return false;  // demo user.

    if (Meteor.settings.public.allowUninvited) return true;  // all accounts qualify

    if (user.signupKey) return true;  // user is invited

    if (this.isUserInOrganization(user)) return true;

    return false;
  },

  isSignedUpOrDemo() {
    const user = Meteor.user();
    return this.isAccountSignedUpOrDemo(user);
  },

  isAccountSignedUpOrDemo(user) {
    if (!user) return false;  // not signed in

    if (!user.loginIdentities) return false;  // not an account

    if (user.expires) return true;  // demo user.

    if (Meteor.settings.public.allowUninvited) return true;  // all accounts qualify

    if (user.signupKey) return true;  // user is invited

    if (this.isUserInOrganization(user)) return true;

    return false;
  },

  isIdentityInOrganization(identity) {
    if (!identity || !identity.services) {
      return false;
    }

    const orgMembership = this.getOrganizationMembership();
    const googleEnabled = orgMembership && orgMembership.google && orgMembership.google.enabled;
    const googleDomain = orgMembership && orgMembership.google && orgMembership.google.domain;
    const emailEnabled = orgMembership && orgMembership.emailToken && orgMembership.emailToken.enabled;
    const emailDomain = orgMembership && orgMembership.emailToken && orgMembership.emailToken.domain;
    const ldapEnabled = orgMembership && orgMembership.ldap && orgMembership.ldap.enabled;
    const samlEnabled = orgMembership && orgMembership.saml && orgMembership.saml.enabled;
    if (emailEnabled && emailDomain && identity.services.email) {
      if (identity.services.email.email.toLowerCase().split("@").pop() === emailDomain) {
        return true;
      }
    } else if (ldapEnabled && identity.services.ldap) {
      return true;
    } else if (samlEnabled && identity.services.saml) {
      return true;
    } else if (googleEnabled && googleDomain && identity.services.google && identity.services.google.hd) {
      if (identity.services.google.hd.toLowerCase() === googleDomain) {
        return true;
      }
    }

    return false;
  },

  isUserInOrganization(user) {
    if (!this.isFeatureKeyValid()) {
      return false;
    }

    for (let i = 0; i < user.loginIdentities.length; i++) {
      let identity = Meteor.users.findOne({ _id: user.loginIdentities[i].id });
      if (this.isIdentityInOrganization(identity)) {
        return true;
      }
    }

    return false;
  },
});

if (Meteor.isServer) {
  SandstormDb.prototype.getWildcardOrigin = getWildcardOrigin;

  const Crypto = Npm.require("crypto");
  SandstormDb.prototype.removeApiTokens = function (query) {
    // Remove all API tokens matching the query, making sure to clean up ApiHosts as well.

    this.collections.apiTokens.find(query).forEach((token) => {
      // Clean up ApiHosts for webkey tokens.
      if (token.hasApiHost) {
        const hash2 = Crypto.createHash("sha256").update(token._id).digest("base64");
        this.collections.apiHosts.remove({ hash2: hash2 });
      }
    });

    this.collections.apiTokens.remove(query);
  };
}

// TODO(someday): clean this up.  Logic for building static asset urls on client and server
// appears all over the codebase.
let httpProtocol;
if (Meteor.isServer) {
  const Url = Npm.require("url");
  httpProtocol = Url.parse(process.env.ROOT_URL).protocol;
} else {
  httpProtocol = window.location.protocol;
}

// =======================================================================================
// Below this point are newly-written or refactored functions.

_.extend(SandstormDb.prototype, {
  getUser(userId) {
    check(userId, Match.OneOf(String, undefined, null));
    if (userId) {
      return Meteor.users.findOne(userId);
    }
  },

  getIdentity(identityId) {
    check(identityId, String);
    const identity = Meteor.users.findOne({ _id: identityId });
    if (identity) {
      SandstormDb.fillInProfileDefaults(identity);
      SandstormDb.fillInIntrinsicName(identity);
      SandstormDb.fillInPictureUrl(identity);
      return identity;
    }
  },

  userHasIdentity(userId, identityId) {
    check(userId, String);
    check(identityId, String);

    if (userId === identityId) return true;

    const user = Meteor.users.findOne(userId);
    return SandstormDb.getUserIdentityIds(user).indexOf(identityId) != -1;
  },

  userGrains(userId, options) {
    check(userId, Match.OneOf(String, undefined, null));
    check(options, Match.OneOf(undefined, null,
        { includeTrashOnly: Match.Optional(Boolean), includeTrash: Match.Optional(Boolean), }));

    const query = { userId: userId };
    if (options && options.includeTrashOnly) {
      query.trashed = { $exists: true };
    } else if (options && options.includeTrash) {
      // Keep query as-is.
    } else {
      query.trashed = { $exists: false };
    }

    return this.collections.grains.find(query);
  },

  currentUserGrains(options) {
    return this.userGrains(Meteor.userId(), options);
  },

  getGrain(grainId) {
    check(grainId, String);
    return this.collections.grains.findOne(grainId);
  },

  userApiTokens(userId, trashed) {
    check(userId, Match.OneOf(String, undefined, null));
    check(trashed, Match.OneOf(Boolean, undefined, null));
    const identityIds = SandstormDb.getUserIdentityIds(this.getUser(userId));
    return this.collections.apiTokens.find({
      "owner.user.identityId": { $in: identityIds },
      trashed: { $exists: !!trashed },
    });
  },

  currentUserApiTokens(trashed) {
    return this.userApiTokens(Meteor.userId(), trashed);
  },

  userActions(user) {
    return this.collections.userActions.find({ userId: user });
  },

  currentUserActions() {
    return this.userActions(Meteor.userId());
  },

  iconSrcForPackage(pkg, usage) {
    return Identicon.iconSrcForPackage(pkg, usage, httpProtocol + "//" + this.makeWildcardHost("static"));
  },

  getDenormalizedGrainInfo(grainId) {
    const grain = this.getGrain(grainId);
    let pkg = this.collections.packages.findOne(grain.packageId);

    if (!pkg) {
      pkg = this.collections.devPackages.findOne(grain.packageId);
    }

    const appTitle = (pkg && pkg.manifest && pkg.manifest.appTitle) || { defaultText: "" };
    const grainInfo = { appTitle: appTitle };

    if (pkg && pkg.manifest && pkg.manifest.metadata && pkg.manifest.metadata.icons) {
      const icons = pkg.manifest.metadata.icons;
      grainInfo.icon = icons.grain || icons.appGrid;
    }

    // Only provide an app ID if we have no icon asset to provide and need to offer an identicon.
    if (!grainInfo.icon && pkg) {
      grainInfo.appId = pkg.appId;
    }

    return grainInfo;
  },

  getPlan(id) {
    check(id, String);
    const plan = this.collections.plans.findOne(id);
    if (!plan) {
      throw new Error("no such plan: " + id);
    }

    return plan;
  },

  listPlans() {
    return this.collections.plans.find({}, { sort: { price: 1 } });
  },

  getMyPlan() {
    const user = Meteor.user();
    return user && this.collections.plans.findOne(user.plan || "free");
  },

  getMyReferralBonus(user) {
    // This function is called from the server and from the client, similar to getMyPlan().
    //
    // The parameter may be omitted in which case the current user is assumed.

    return calculateReferralBonus(user || Meteor.user());
  },

  getMyUsage(user) {
    user = user || Meteor.user();
    if (user && (Meteor.isServer || user.pseudoUsage)) {
      if (Meteor.isClient) {
        // Filled by pseudo-subscription to "getMyUsage". WARNING: The subscription is currently
        // not reactive.
        return user.pseudoUsage;
      } else {
        return {
          grains: this.collections.grains.find({ userId: user._id }).count(),
          storage: user.storageUsage || 0,
          compute: 0,  // not tracked yet
        };
      }
    } else {
      return { grains: 0, storage: 0, compute: 0 };
    }
  },

  isUninvitedFreeUser() {
    if (!Meteor.settings.public.allowUninvited) return false;

    const user = Meteor.user();
    return user && !user.expires && (!user.plan || user.plan === "free");
  },

  getSetting(name) {
    const setting = this.collections.settings.findOne(name);
    return setting && setting.value;
  },

  getSettingWithFallback(name, fallbackValue) {
    const value = this.getSetting(name);
    if (value === undefined) {
      return fallbackValue;
    }

    return value;
  },

  addUserActions(userId, packageId, simulation) {
    check(userId, String);
    check(packageId, String);

    const pack = this.collections.packages.findOne({ _id: packageId });
    if (pack) {
      // Remove old versions.
      const numRemoved = this.collections.userActions.remove({ userId: userId, appId: pack.appId });

      // Install new.
      const actions = pack.manifest.actions;
      for (const i in actions) {
        const action = actions[i];
        if ("none" in action.input) {
          const userAction = {
            userId: userId,
            packageId: pack._id,
            appId: pack.appId,
            appTitle: pack.manifest.appTitle,
            appMarketingVersion: pack.manifest.appMarketingVersion,
            appVersion: pack.manifest.appVersion,
            title: action.title,
            nounPhrase: action.nounPhrase,
            command: action.command,
          };
          this.collections.userActions.insert(userAction);
        } else {
          // TODO(someday):  Implement actions with capability inputs.
        }
      }

      if (numRemoved > 0 && !simulation) {
        this.deleteUnusedPackages(pack.appId);
      }
    }
  },

  sendAdminNotification(type, action) {
    Meteor.users.find({ isAdmin: true }, { fields: { _id: 1 } }).forEach(function (user) {
      Notifications.insert({
        admin: { action, type },
        userId: user._id,
        timestamp: new Date(),
        isUnread: true,
      });
    });
  },

  getKeybaseProfile(keyFingerprint) {
    return this.collections.keybaseProfiles.findOne(keyFingerprint) || {};
  },

  getServerTitle() {
    const setting = this.collections.settings.findOne({ _id: "serverTitle" });
    return setting ? setting.value : "";  // empty if subscription is not ready.
  },

  getSmtpConfig() {
    const setting = this.collections.settings.findOne({ _id: "smtpConfig" });
    return setting ? setting.value : undefined; // undefined if subscription is not ready.
  },

  getReturnAddress() {
    const config = this.getSmtpConfig();
    return config && config.returnAddress || ""; // empty if subscription is not ready.
  },

  getReturnAddressWithDisplayName(identityId) {
    check(identityId, String);
    const identity = this.getIdentity(identityId);
    const displayName = identity.profile.name + " (via " + this.getServerTitle() + ")";

    // First remove any instances of characters that cause trouble for SimpleSmtp. Ideally,
    // we could escape such characters with a backslash, but that does not seem to help here.
    const sanitized = displayName.replace(/"|<|>|\\|\r/g, "");

    return "\"" + sanitized + "\" <" + this.getReturnAddress() + ">";
  },

  getPrimaryEmail(accountId, identityId) {
    check(accountId, String);
    check(identityId, String);

    const identity = this.getIdentity(identityId);
    const senderEmails = SandstormDb.getVerifiedEmails(identity);
    const senderPrimaryEmail = _.findWhere(senderEmails, { primary: true });
    const accountPrimaryEmailAddress = this.getUser(accountId).primaryEmail;
    if (_.findWhere(senderEmails, { email: accountPrimaryEmailAddress })) {
      return accountPrimaryEmailAddress;
    } else if (senderPrimaryEmail) {
      return senderPrimaryEmail.email;
    } else {
      return null;
    }
  },

  incrementDailySentMailCount(accountId) {
    check(accountId, String);

    const DAILY_LIMIT = 50;
    const result = Meteor.users.findAndModify({
      query: { _id: accountId },
      update: {
        $inc: {
          dailySentMailCount: 1,
        },
      },
      fields: { dailySentMailCount: 1 },
    });

    if (!result.ok) {
      throw new Error("Couldn't update daily sent mail count.");
    }

    const user = result.value;
    if (user.dailySentMailCount >= DAILY_LIMIT) {
      throw new Error(
          "Sorry, you've reached your e-mail sending limit for today. Currently, Sandstorm " +
          "limits each user to " + DAILY_LIMIT + " e-mails per day for spam control reasons. " +
          "Please feel free to contact us if this is a problem.");
    }
  },

  isFeatureKeyValid() {
    const featureKey = this.currentFeatureKey();
    return !!featureKey;
  },

  isFeatureKeyValidAndNotExpired() {
    const featureKey = this.currentFeatureKey();
    return featureKey && (parseInt(featureKey.expires) > (Date.now() / 1000));
  },

  isFeatureKeyOptedIntoStats() {
    const featureKey = this.currentFeatureKey();
    return featureKey && featureKey.isTrial && parseInt(featureKey.issued) > 1472601600;
    // 1472601600 is 2016 Aug 31 in seconds since the epoch
  },

  getLdapUrl() {
    const setting = this.collections.settings.findOne({ _id: "ldapUrl" });
    return setting ? setting.value : "";  // empty if subscription is not ready.
  },

  getLdapBase() {
    const setting = this.collections.settings.findOne({ _id: "ldapBase" });
    return setting ? setting.value : "";  // empty if subscription is not ready.
  },

  getLdapDnPattern() {
    const setting = this.collections.settings.findOne({ _id: "ldapDnPattern" });
    return setting ? setting.value : "";  // empty if subscription is not ready.
  },

  getLdapSearchUsername() {
    const setting = this.collections.settings.findOne({ _id: "ldapSearchUsername" });
    return setting ? setting.value : "";  // empty if subscription is not ready.
  },

  getLdapNameField() {
    const setting = this.collections.settings.findOne({ _id: "ldapNameField" });
    return setting ? setting.value : "";  // empty if subscription is not ready.
  },

  getLdapEmailField() {
    const setting = this.collections.settings.findOne({ _id: "ldapEmailField" });
    return setting ? setting.value : "mail";
    // default to "mail". This setting was added later, and so could potentially be unset.
  },

  getLdapExplicitDnSelected() {
    const setting = this.collections.settings.findOne({ _id: "ldapExplicitDnSelected" });
    return setting && setting.value;
  },

  getLdapFilter() {
    const setting = this.collections.settings.findOne({ _id: "ldapFilter" });
    return setting ? setting.value : "";  // empty if subscription is not ready.
  },

  getLdapSearchBindDn() {
    const setting = this.collections.settings.findOne({ _id: "ldapSearchBindDn" });
    return setting ? setting.value : "";  // empty if subscription is not ready.
  },

  getLdapSearchBindPassword() {
    const setting = this.collections.settings.findOne({ _id: "ldapSearchBindPassword" });
    return setting ? setting.value : "";  // empty if subscription is not ready.
  },

  getOrganizationMembership() {
    const setting = this.collections.settings.findOne({ _id: "organizationMembership" });
    return setting && setting.value;
  },

  getOrganizationEmailEnabled() {
    const membership = this.getOrganizationMembership();
    return membership && membership.emailToken && membership.emailToken.enabled;
  },

  getOrganizationEmailDomain() {
    const membership = this.getOrganizationMembership();
    return membership && membership.emailToken && membership.emailToken.domain;
  },

  getOrganizationGoogleEnabled() {
    const membership = this.getOrganizationMembership();
    return membership && membership.google && membership.google.enabled;
  },

  getOrganizationGoogleDomain() {
    const membership = this.getOrganizationMembership();
    return membership && membership.google && membership.google.domain;
  },

  getOrganizationLdapEnabled() {
    const membership = this.getOrganizationMembership();
    return membership && membership.ldap && membership.ldap.enabled;
  },

  getOrganizationSamlEnabled() {
    const membership = this.getOrganizationMembership();
    return membership && membership.saml && membership.saml.enabled;
  },

  getOrganizationDisallowGuests() {
    return this.getOrganizationDisallowGuestsRaw() && this.isFeatureKeyValid();
  },

  getOrganizationDisallowGuestsRaw() {
    const setting = this.collections.settings.findOne({ _id: "organizationSettings" });
    return setting && setting.value && setting.value.disallowGuests;
  },

  getOrganizationShareContacts() {
    return this.getOrganizationShareContactsRaw() && this.isFeatureKeyValid();
  },

  getOrganizationShareContactsRaw() {
    const setting = this.collections.settings.findOne({ _id: "organizationSettings" });
    if (!setting || !setting.value || setting.value.shareContacts === undefined) {
      // default to true if undefined
      return true;
    } else {
      return setting.value.shareContacts;
    }
  },

  getSamlEntryPoint() {
    const setting = this.collections.settings.findOne({ _id: "samlEntryPoint" });
    return setting ? setting.value : "";  // empty if subscription is not ready.
  },

  getSamlPublicCert() {
    const setting = this.collections.settings.findOne({ _id: "samlPublicCert" });
    return setting ? setting.value : "";  // empty if subscription is not ready.
  },

  getSamlEntityId() {
    const setting = this.collections.settings.findOne({ _id: "samlEntityId" });
    return setting ? setting.value : ""; // empty if subscription is not ready.
  },

  getActivitySubscriptions(grainId, threadPath) {
    return this.collections.activitySubscriptions.find({
      grainId: grainId,
      threadPath: threadPath || { $exists: false },
    }, {
      fields: { identityId: 1, mute: 1, _id: 0 },
    }).fetch();
  },

  subscribeToActivity(identityId, grainId, threadPath) {
    // Subscribe the given identity to activity events with the given grainId and (optional)
    // threadPath -- unless the identity has previously muted this grainId/threadPath, in which
    // case do nothing.

    const record = { identityId, grainId };
    if (threadPath) {
      record.threadPath = threadPath;
    }

    // The $set here is redundant since an upsert automatically initializes a new record to contain
    // the fields from the query, but if we try to do { $set: {} } Mongo throws an exception, and
    // if we try to just pass {}, Mongo interprets it as "replace the record with an empty record".
    // What a wonderful query language.
    this.collections.activitySubscriptions.upsert(record, { $set: record });
  },

  muteActivity(identityId, grainId, threadPath) {
    // Mute notifications for the given identity originating from the given grainId and
    // (optional) threadPath.

    const record = { identityId, grainId };
    if (threadPath) {
      record.threadPath = threadPath;
    }

    this.collections.activitySubscriptions.upsert(record, { $set: { mute: true } });
  },

  updateAppIndex() {
    const appUpdatesEnabledSetting = this.collections.settings.findOne({ _id: "appUpdatesEnabled" });
    const appUpdatesEnabled = appUpdatesEnabledSetting && appUpdatesEnabledSetting.value;
    if (!appUpdatesEnabled) {
      // It's much simpler to check appUpdatesEnabled here rather than reactively deactivate the
      // timer that triggers this call.
      return;
    }

    const appIndexUrl = this.collections.settings.findOne({ _id: "appIndexUrl" }).value;
    const appIndex = this.collections.appIndex;
    const data = HTTP.get(appIndexUrl + "/apps/index.json").data;
    const preinstalledAppIds = this.getAllPreinstalledAppIds();
    // We make sure to get all preinstalled appIds, even ones that are currently
    // downloading/failed.
    data.apps.forEach((app) => {
      app._id = app.appId;

      const oldApp = appIndex.findOne({ _id: app.appId });
      app.hasSentNotifications = false;
      appIndex.upsert({ _id: app._id }, app);
      const isAppPreinstalled = _.contains(preinstalledAppIds, app.appId);
      if ((!oldApp || app.versionNumber > oldApp.versionNumber) &&
          (this.collections.userActions.findOne({ appId: app.appId }) ||
          isAppPreinstalled)) {
        const pack = this.collections.packages.findOne({ _id: app.packageId });
        const url = appIndexUrl + "/packages/" + app.packageId;
        if (pack) {
          if (pack.status === "ready") {
            if (pack.appId && pack.appId !== app.appId) {
              console.error("app index returned app ID and package ID that don't match:",
                            JSON.stringify(app));
            } else {
              this.sendAppUpdateNotifications(app.appId, app.packageId, app.name, app.versionNumber,
                app.version);
              if (isAppPreinstalled) {
                this.setPreinstallAppAsReady(app.appId, app.packageId);
              }
            }
          } else {
            const result = this.collections.packages.findAndModify({
              query: { _id: app.packageId },
              update: { $set: { isAutoUpdated: true } },
            });

            if (!result.ok) {
              return;
            }

            const newPack = result.value;
            if (newPack.status === "ready") {
              // The package was marked as ready before we applied isAutoUpdated=true. We should send
              // notifications ourselves to be sure there's no timing issue (sending more than one is
              // fine, since it will de-dupe).
              if (pack.appId && pack.appId !== app.appId) {
                console.error("app index returned app ID and package ID that don't match:",
                              JSON.stringify(app));
              } else {
                this.sendAppUpdateNotifications(app.appId, app.packageId, app.name, app.versionNumber,
                  app.version);
                if (isAppPreinstalled) {
                  this.setPreinstallAppAsReady(app.appId, app.packageId);
                }
              }
            } else if (newPack.status === "failed") {
              // If the package has failed, retry it
              this.startInstall(app.packageId, url, true, true);
            }
          }
        } else {
          this.startInstall(app.packageId, url, false, true);
        }
      }
    });
  },

  isPackagePreinstalled(packageId) {
    return this.collections.settings.find({ _id: "preinstalledApps", "value.packageId": packageId }).count() === 1;
  },

  getAppIdForPreinstalledPackage(packageId) {
    const setting = this.collections.settings.findOne({ _id: "preinstalledApps", "value.packageId": packageId },
    { fields: { "value.$": 1 } });
    // value.$ causes mongo to transform the result and only return the first matching element in
    // the array
    return setting && setting.value && setting.value[0] && setting.value[0].appId;
  },

  getPackageIdForPreinstalledApp(appId) {
    const setting = this.collections.settings.findOne({ _id: "preinstalledApps", "value.appId": appId },
    { fields: { "value.$": 1 } });
    // value.$ causes mongo to transform the result and only return the first matching element in
    // the array
    return setting && setting.value && setting.value[0] && setting.value[0].packageId;
  },

  getReadyPreinstalledAppIds() {
    const setting = this.collections.settings.findOne({ _id: "preinstalledApps" });
    const ret = setting && setting.value || [];
    return _.chain(ret)
            .filter((app) => { return app.status === "ready"; })
            .map((app) => { return app.appId; })
            .value();
  },

  getAllPreinstalledAppIds() {
    const setting = this.collections.settings.findOne({ _id: "preinstalledApps" });
    const ret = setting && setting.value || [];
    return _.map(ret, (app) => { return app.appId; });
  },

  preinstallAppsForUser(userId) {
    const appIds = this.getReadyPreinstalledAppIds();
    appIds.forEach((appId) => {
      try {
        this.addUserActions(userId, this.getPackageIdForPreinstalledApp(appId));
      } catch (e) {
        console.error("failed to install app for user:", e);
      }
    });
  },

  setPreinstallAppAsDownloading(appId, packageId) {
    this.collections.settings.update(
      { _id: "preinstalledApps", "value.appId": appId, "value.packageId": packageId },
      { $set: { "value.$.status": "downloading" } });
  },

  setPreinstallAppAsReady(appId, packageId) {
    // This function both sets the appId as ready and updates the packageId for the given appId
    // Setting the packageId is especially useful in installer.js, as it always ensures the
    // latest installed package will be set as ready.
    this.collections.settings.update(
      { _id: "preinstalledApps", "value.appId": appId },
      { $set: { "value.$.status": "ready", "value.$.packageId": packageId } });
  },

  ensureAppPreinstall(appId, packageId) {
    check(appId, String);
    const appIndexUrl = this.collections.settings.findOne({ _id: "appIndexUrl" }).value;
    const pack = this.collections.packages.findOne({ _id: packageId });
    const url = appIndexUrl + "/packages/" + packageId;
    if (pack && pack.status === "ready") {
      this.setPreinstallAppAsReady(appId, packageId);
    } else if (pack && pack.status === "failed") {
      this.setPreinstallAppAsDownloading(appId, packageId);
      this.startInstall(packageId, url, true, false);
    } else {
      this.setPreinstallAppAsDownloading(appId, packageId);
      this.startInstall(packageId, url, false, false);
    }
  },

  setPreinstalledApps(appAndPackageIds) {
    // appAndPackageIds: A List[Object] where each element has fields:
    //     appId: The Packages.appId of the app to install
    //     packageId: The Packages._id of the app to install
    check(appAndPackageIds, [{ appId: String, packageId: String, }]);

    // Start by clearing out the setting. We'll push appIds one by one to it
    this.collections.settings.upsert({ _id: "preinstalledApps" }, { $set: {
      value: appAndPackageIds.map((data) => {
        return {
          appId: data.appId,
          status: "notReady",
          packageId: data.packageId,
        };
      }),
    }, });
    appAndPackageIds.forEach((data) => {
      this.ensureAppPreinstall(data.appId, data.packageId);
    });
  },

  getProductivitySuiteAppIds() {
    return [
      "8aspz4sfjnp8u89000mh2v1xrdyx97ytn8hq71mdzv4p4d8n0n3h", // Davros
      "h37dm17aa89yrd8zuqpdn36p6zntumtv08fjpu8a8zrte7q1cn60", // Etherpad
      "vfnwptfn02ty21w715snyyczw0nqxkv3jvawcah10c6z7hj1hnu0", // Rocket.Chat
      "m86q05rdvj14yvn78ghaxynqz7u2svw6rnttptxx49g1785cdv1h", // Wekan
    ];
  },

  getSystemSuiteAppIds() {
    return [
      "s3u2xgmqwznz2n3apf30sm3gw1d85y029enw5pymx734cnk5n78h", // Collections
    ];
  },

  isPreinstalledAppsReady() {
    const setting = this.collections.settings.findOne({ _id: "preinstalledApps" });
    if (!setting || !setting.value) {
      return true;
    }

    const packageIds = _.pluck(setting.value, "packageId");
    const readyApps = this.collections.packages.find({
      _id: {
        $in: packageIds,
      },
      status: "ready",
    });
    return readyApps.count() === packageIds.length;
  },

  getBillingPromptUrl() {
    const setting = this.collections.settings.findOne({ _id: "billingPromptUrl" });
    return setting && setting.value;
  },

  isReferralEnabled() {
    // This function is a bit weird, in that we've transitioned from
    // Meteor.settings.public.quotaEnabled to DB settings. For now,
    // Meteor.settings.public.quotaEnabled implies bothisReferralEnabled and isQuotaEnabled are true.
    return Meteor.settings.public.quotaEnabled;
  },

  isQuotaEnabled() {
    if (Meteor.settings.public.quotaEnabled) return true;

    const setting = this.collections.settings.findOne({ _id: "quotaEnabled" });
    return setting && setting.value && this.isFeatureKeyValid();
  },

  isQuotaLdapEnabled() {
    const setting = this.collections.settings.findOne({ _id: "quotaLdapEnabled" });
    return setting && setting.value && this.isFeatureKeyValid();
  },

  updateUserQuota(user) {
    if (this.quotaManager) {
      return this.quotaManager.updateUserQuota(this, user);
    }
  },

  getUserQuota(user) {
    if (this.isQuotaLdapEnabled()) {
      return this.quotaManager.updateUserQuota(this, user);
    } else {
      const plan = this.collections.plans.findOne(user.plan || "free");
      const referralBonus = calculateReferralBonus(user);
      const bonus = user.planBonus || {};
      const userQuota = {
        storage: plan.storage + referralBonus.storage + (bonus.storage || 0),
        grains: plan.grains + referralBonus.grains + (bonus.grains || 0),
        compute: plan.compute + (bonus.compute || 0),
      };
      return userQuota;
    }
  },

  isUserOverQuota(user) {
    // Return false if user has quota space remaining, true if it is full. When this returns true,
    // we will not allow the user to create new grains, though they may be able to open existing ones
    // which may still increase their storage usage.
    //
    // (Actually returns a string which can be fed into `billingPrompt` as the reason.)

    if (!this.isQuotaEnabled() || user.isAdmin) return false;

    const plan = this.getUserQuota(user);
    if (plan.grains < Infinity) {
      const count = this.collections.grains.find({ userId: user._id },
        { fields: {}, limit: plan.grains }).count();
      if (count >= plan.grains) return "outOfGrains";
    }

    return plan && user.storageUsage && user.storageUsage >= plan.storage && "outOfStorage";
  },

  isUserExcessivelyOverQuota(user) {
    // Return true if user is so far over quota that we should prevent their existing grains from
    // running at all.
    //
    // (Actually returns a string which can be fed into `billingPrompt` as the reason.)

    if (!this.isQuotaEnabled() || user.isAdmin) return false;

    const quota = this.getUserQuota(user);

    // quota.grains = Infinity means unlimited grains. IEEE754 defines Infinity == Infinity.
    if (quota.grains < Infinity) {
      const count = this.collections.grains.find({ userId: user._id },
        { fields: {}, limit: quota.grains * 2 }).count();
      if (count >= quota.grains * 2) return "outOfGrains";
    }

    return quota && user.storageUsage && user.storageUsage >= quota.storage * 1.2 && "outOfStorage";
  },

  suspendIdentity(userId, suspension) {
    check(userId, String);
    check(suspension, {
      timestamp: Date,
      admin: Match.Optional(String),
      voluntary: Match.Optional(Boolean),
    });

    this.collections.users.update({ _id: userId }, { $set: { suspended: suspension } });
    this.collections.apiTokens.update({ "owner.user.identityId": userId },
      { $set: { suspended: true } }, { multi: true });
  },

  unsuspendIdentity(userId) {
    check(userId, String);

    this.collections.users.update({ _id: userId }, { $unset: { suspended: 1 } });
    this.collections.apiTokens.update({ "owner.user.identityId": userId },
      { $unset: { suspended: true } }, { multi: true });
  },

  suspendAccount(userId, byAdminUserId, willDelete) {
    check(userId, String);
    check(byAdminUserId, Match.OneOf(String, null, undefined));
    check(willDelete, Boolean);

    const user = this.collections.users.findOne({ _id: userId });
    const suspension = {
      timestamp: new Date(),
      willDelete: willDelete || false,
    };
    if (byAdminUserId) {
      suspension.admin = byAdminUserId;
    } else {
      suspension.voluntary = true;
    }

    this.collections.users.update({ _id: userId }, { $set: { suspended: suspension } });
    this.collections.grains.update({ userId: userId }, { $set: { suspended: true } }, { multi: true });

    delete suspension.willDelete;
    // Only mark the parent account for deletion. This makes the query simpler later.

    user.loginIdentities.forEach((identity) => {
      this.suspendIdentity(identity.id, suspension);
    });
    user.nonloginIdentities.forEach((identity) => {
      if (this.collections.users.find({ $or: [
        { "loginIdentities.id": identity.id },
        { "nonloginIdentities.id": identity.id },
      ], }).count() === 1) {
        // Only suspend non-login identities that are unique to this account.
        this.suspendIdentity(identity.id, suspension);
      }
    });

    // Force logout this user
    this.collections.users.update({ _id: userId },
      { $unset: { "services.resume.loginTokens": 1 } });
    if (user && user.loginIdentities) {
      user.loginIdentities.forEach(function (identity) {
        Meteor.users.update({ _id: identity.id }, { $unset: { "services.resume.loginTokens": 1 } });
      });
    }
  },

  unsuspendAccount(userId) {
    check(userId, String);

    const user = this.collections.users.findOne({ _id: userId });
    this.collections.users.update({ _id: userId }, { $unset: { suspended: 1 } });
    this.collections.grains.update({ userId: userId }, { $unset: { suspended: 1 } }, { multi: true });

    user.loginIdentities.forEach((identity) => {
      this.unsuspendIdentity(identity.id);
    });

    user.nonloginIdentities.forEach((identity) => {
      this.unsuspendIdentity(identity.id);
    });
  },

  deletePendingAccounts(deletionCoolingOffTime, backend, cb) {
    check(deletionCoolingOffTime, Number);

    const queryDate = new Date(Date.now() - deletionCoolingOffTime);
    this.collections.users.find({
      "suspended.willDelete": true,
      "suspended.timestamp": { $lt: queryDate },
    }).forEach((user) => {
      if (cb) cb(this, user);
      this.deleteAccount(user._id, backend);
    });
  },
});

SandstormDb.escapeMongoKey = (key) => {
  // This incredibly poor mechanism for escaping Mongo keys is recommended by the Mongo docs here:
  //   https://docs.mongodb.org/manual/faq/developers/#dollar-sign-operator-escaping
  // and seems to be a de facto standard, for example:
  //   https://www.npmjs.com/package/mongo-key-escape
  return key.replace(".", "\uFF0E").replace("$", "\uFF04");
};

const appNameFromPackage = function (packageObj) {
  // This function takes a Package object from Mongo and returns an
  // app title.
  const manifest = packageObj.manifest;
  if (!manifest) return packageObj.appId || packageObj._id || "unknown";
  const action = manifest.actions[0];
  appName = (manifest.appTitle && manifest.appTitle.defaultText) ||
    appNameFromActionName(action.title.defaultText);
  return appName;
};

const appNameFromActionName = function (name) {
  // Hack: Historically we only had action titles, like "New Etherpad Document", not app
  //   titles. But for this UI we want app titles. As a transitionary measure, try to
  //   derive the app title from the action title.
  // TODO(cleanup): Get rid of this once apps have real titles.
  if (!name) {
    return "(unnamed)";
  }

  if (name.lastIndexOf("New ", 0) === 0) {
    name = name.slice(4);
  }

  if (name.lastIndexOf("Hacker CMS", 0) === 0) {
    name = "Hacker CMS";
  } else {
    const space = name.indexOf(" ");
    if (space > 0) {
      name = name.slice(0, space);
    }
  }

  return name;
};

const appShortDescriptionFromPackage = function (pkg) {
  return pkg && pkg.manifest && pkg.manifest.metadata &&
         pkg.manifest.metadata.shortDescription &&
         pkg.manifest.metadata.shortDescription.defaultText;
};

const nounPhraseForActionAndAppTitle = function (action, appTitle) {
  // A hack to deal with legacy apps not including fields in their manifests.
  // I look forward to the day I can remove most of this code.
  // Attempt to figure out the appropriate noun that this action will create.
  // Use an explicit noun phrase is one is available.  Apps should add these in the future.
  if (action.nounPhrase) return action.nounPhrase.defaultText;
  // Otherwise, try to guess one from the structure of the action title field
  if (action.title && action.title.defaultText) {
    const text = action.title.defaultText;
    // Strip a leading "New "
    if (text.lastIndexOf("New ", 0) === 0) {
      const candidate = text.slice(4);
      // Strip a leading appname too, if provided
      if (candidate.lastIndexOf(appTitle, 0) === 0) {
        const newCandidate = candidate.slice(appTitle.length);
        // Unless that leaves you with no noun, in which case, use "grain"
        if (newCandidate.length > 0) {
          return newCandidate.toLowerCase();
        } else {
          return "grain";
        }
      }

      return candidate.toLowerCase();
    }
    // Some other verb phrase was given.  Just use it verbatim, and hope the app author updates
    // the package soon.
    return text;
  } else {
    return "grain";
  }
};

// Static methods on SandstormDb that don't need an instance.
// Largely things that deal with backwards-compatibility.
_.extend(SandstormDb, {
  appNameFromActionName: appNameFromActionName,
  appNameFromPackage: appNameFromPackage,
  appShortDescriptionFromPackage: appShortDescriptionFromPackage,
  nounPhraseForActionAndAppTitle: nounPhraseForActionAndAppTitle,
});

if (Meteor.isServer) {
  const Crypto = Npm.require("crypto");
  const ContentType = Npm.require("content-type");
  const Zlib = Npm.require("zlib");
  const Url = Npm.require("url");

  const replicaNumber = Meteor.settings.replicaNumber || 0;

  const computeStagger = function (n) {
    // Compute a fraction in the range [0, 1) such that, for any natural number k, the values
    // of computeStagger(n) for all n in [1, 2^k) are uniformly distributed between 0 and 1.
    // The sequence looks like:
    //   0, 1/2, 1/4, 3/4, 1/8, 3/8, 5/8, 7/8, 1/16, ...
    //
    // We use this to determine how we'll stagger periodic events performed by this replica.
    // Notice that this allows us to compute a stagger which is independent of the number of
    // front-end replicas present; we can add more replicas to the end without affecting how the
    // earlier ones schedule their events.
    let denom = 1;
    while (denom <= n) denom <<= 1;
    const num = n * 2 - denom + 1;
    return num / denom;
  };

  const stagger = computeStagger(replicaNumber);

  SandstormDb.periodicCleanup = function (intervalMs, callback) {
    // Register a database cleanup function than should run periodically, roughly once every
    // interval of the given length.
    //
    // In a blackrock deployment with multiple front-ends, the frequency of the cleanup will be
    // scaled appropriately on the assumption that more data is being generated demanding more
    // frequent cleanups.

    check(intervalMs, Number);
    check(callback, Function);

    if (intervalMs < 120000) {
      throw new Error("less than 2-minute cleanup interval seems too fast; " +
                      "are you using the right units?");
    }

    // Schedule first cleanup to happen at the next intervalMs interval from the epoch, so that
    // the schedule is independent of the exact startup time.
    let first = intervalMs - Date.now() % intervalMs;

    // Stagger cleanups across replicas so that we don't have all replicas trying to clean the
    // same data at the same time.
    first += Math.floor(intervalMs * computeStagger(replicaNumber));

    // If the stagger put us more than an interval away from now, back up.
    if (first > intervalMs) first -= intervalMs;

    Meteor.setTimeout(function () {
      callback();
      Meteor.setInterval(callback, intervalMs);
    }, first);
  };

  // TODO(cleanup): Node 0.12 has a `gzipSync` but 0.10 (which Meteor still uses) does not.
  const gzipSync = Meteor.wrapAsync(Zlib.gzip, Zlib);

  const BufferSmallerThan = function (limit) {
    return Match.Where(function (buf) {
      check(buf, Buffer);
      return buf.length < limit;
    });
  };

  const DatabaseId = Match.Where(function (s) {
    check(s, String);
    return !!s.match(/^[a-zA-Z0-9_]+$/);
  });

  SandstormDb.prototype.addStaticAsset = function (metadata, content) {
    // Add a new static asset to the database. If `content` is a string rather than a buffer, it
    // will be automatically gzipped before storage; do not specify metadata.encoding in this case.

    if (typeof content === "string" && !metadata.encoding) {
      content = gzipSync(new Buffer(content, "utf8"));
      metadata.encoding = "gzip";
    }

    check(metadata, {
      mimeType: String,
      encoding: Match.Optional("gzip"),
    });
    check(content, BufferSmallerThan(1 << 20));

    // Validate content type.
    metadata.mimeType = ContentType.format(ContentType.parse(metadata.mimeType));

    const hasher = Crypto.createHash("sha256");
    hasher.update(metadata.mimeType + "\n" + metadata.encoding + "\n", "utf8");
    hasher.update(content);
    const hash = hasher.digest("base64");

    const result = this.collections.staticAssets.findAndModify({
      query: { hash: hash, refcount: { $gte: 1 } },
      update: { $inc: { refcount: 1 } },
      fields: { _id: 1, refcount: 1 },
    });

    if (!result.ok) {
      throw new Error(`Couldn't increment refcount of asset with hash ${hash}`);
    }

    const existing = result.value;
    if (existing) {
      return existing._id;
    }

    return this.collections.staticAssets.insert(_.extend({
      hash: hash,
      content: content,
      refcount: 1,
    }, metadata));
  };

  SandstormDb.prototype.refStaticAsset = function (id) {
    // Increment the refcount on an existing static asset. Returns the asset on success.
    // If the asset does not exist, returns a falsey value.
    //
    // You must call this BEFORE adding the new reference to the DB, in case of failure between
    // the two calls. (This way, the failure case is a storage leak, which is probably not a big
    // deal and can be fixed by GC, rather than a mysteriously missing asset.)

    check(id, String);

    const result = this.collections.staticAssets.findAndModify({
      query: { hash: hash },
      update: { $inc: { refcount: 1 } },
      fields: { _id: 1, content: 1, mimeType: 1 },
    });

    if (!result.ok) {
      throw new Error(`Couldn't increment refcount of asset with hash ${hash}`);
    }

    const existing = result.value;
    return existing;
  };

  SandstormDb.prototype.unrefStaticAsset = function (id) {
    // Decrement refcount on a static asset and delete if it has reached zero.
    //
    // You must call this AFTER removing the reference from the DB, in case of failure between
    // the two calls. (This way, the failure case is a storage leak, which is probably not a big
    // deal and can be fixed by GC, rather than a mysteriously missing asset.)

    check(id, String);

    const result = this.collections.staticAssets.findAndModify({
      query: { _id: id },
      update: { $inc: { refcount: -1 } },
      fields: { _id: 1, refcount: 1 },
      new: true,
    });

    if (!result.ok) {
      throw new Error(`Couldn't unref static asset ${id}`);
    }

    const existing = result.value;
    if (!existing) {
      console.error(new Error("unrefStaticAsset() called on asset that doesn't exist").stack);
    } else if (existing.refcount <= 0) {
      this.collections.staticAssets.remove({ _id: existing._id });
    }
  };

  SandstormDb.prototype.getStaticAsset = function (id) {
    // Get a static asset's mimeType, encoding, and raw content.

    check(id, String);

    const asset = this.collections.staticAssets.findOne(id, { fields: { _id: 0, mimeType: 1, encoding: 1, content: 1 } });
    if (asset) {
      // TODO(perf): Mongo converts buffers to something else. Figure out a way to avoid a copy
      //   here.
      asset.content = new Buffer(asset.content);
    }

    return asset;
  };

  SandstormDb.prototype.newAssetUpload = function (purpose) {
    check(purpose, Match.OneOf(
      { profilePicture: { userId: DatabaseId, identityId: DatabaseId } },
      { loginLogo: {} },
    ));

    return this.collections.assetUploadTokens.insert({
      purpose: purpose,
      expires: new Date(Date.now() + 300000),  // in 5 minutes
    });
  };

  SandstormDb.prototype.fulfillAssetUpload = function (id) {
    // Indicates that the given asset upload has completed. It will be removed and its purpose
    // returned. If no matching upload exists, returns undefined.

    check(id, String);

    const result = this.collections.assetUploadTokens.findAndModify({
      query: { _id: id },
      remove: true,
    });

    if (!result.ok) {
      throw new Error("Failed to remove asset upload token");
    }

    const upload = result.value;

    if (upload.expires.valueOf() < Date.now()) {
      return undefined;  // already expired
    } else {
      return upload.purpose;
    }
  };

  SandstormDb.prototype.cleanupExpiredAssetUploads = function () {
    this.collections.assetUploadTokens.remove({ expires: { $lt: Date.now() } });
  };

  // TODO(cleanup): lift this out of the package so it can share with the ones in async-helpers.js
  const Future = Npm.require("fibers/future");
  const promiseToFuture = (promise) => {
    const result = new Future();
    promise.then(result.return.bind(result), result.throw.bind(result));
    return result;
  };

  const waitPromise = (promise) => {
    return promiseToFuture(promise).wait();
  };

  SandstormDb.prototype.deleteGrains = function (query, backend, type) {
    // Returns the number of grains deleted.

    check(type, Match.OneOf("grain", "demoGrain"));

    let numDeleted = 0;
    this.collections.grains.find(query).forEach((grain) => {
      waitPromise(backend.deleteGrain(grain._id, grain.userId));
      numDeleted += this.collections.grains.remove({ _id: grain._id });
      this.removeApiTokens({
        grainId: grain._id,
        $or: [
          { owner: { $exists: false } },
          { owner: { webkey: null } },
        ],
      });

      this.removeApiTokens({ "owner.grain.grainId": grain._id });

      this.collections.activitySubscriptions.remove({ grainId: grain._id });

      if (grain.lastUsed) {
        this.collections.deleteStats.insert({
          type: "grain",  // Demo grains can never get here!
          lastActive: grain.lastUsed,
          appId: grain.appId,
        });
      }

      this.deleteUnusedPackages(grain.appId);

      if (grain.size) {
        Meteor.users.update(grain.userId, { $inc: { storageUsage: -grain.size } });
      }
    });
    return numDeleted;
  };

  SandstormDb.prototype.userGrainTitle = function (grainId, accountId, identityId) {
    check(grainId, String);
    check(accountId, Match.OneOf(String, undefined, null));
    check(identityId, String);

    const grain = this.getGrain(grainId);
    if (!grain) {
      throw new Error("called userGrainTitle() for a grain that doesn't exist");
    }

    let title = grain.title;
    if (grain.userId !== accountId) {
      const sharerToken = this.collections.apiTokens.findOne({
        grainId: grainId,
        "owner.user.identityId": identityId,
      }, {
        sort: {
          lastUsed: -1,
        },
      });
      if (sharerToken) {
        title = sharerToken.owner.user.title;
      } else {
        title = "shared grain";
      }
    }

    return title;
  };

  const packageCache = {};
  // Package info is immutable. Let's cache to save on mongo queries.

  SandstormDb.prototype.getPackage = function (packageId) {
    // Get the given package record. Since package info is immutable, cache the data in the server
    // to reduce mongo query overhead, since it turns out we have to fetch specific packages a
    // lot.

    if (packageId in packageCache) {
      return packageCache[packageId];
    }

    const pkg = this.collections.packages.findOne(packageId);
    if (pkg && pkg.status === "ready") {
      packageCache[packageId] = pkg;
    }

    return pkg;
  };

  SandstormDb.prototype.deleteUnusedPackages = function (appId) {
    check(appId, String);
    this.collections.packages.find({ appId: appId }).forEach((pkg) => {
      // Mark package for possible deletion;
      this.collections.packages.update({ _id: pkg._id, status: "ready" }, { $set: { shouldCleanup: true } });
    });
  };

  SandstormDb.prototype.sendAppUpdateNotifications = function (appId, packageId, name,
                                                               versionNumber, marketingVersion) {
    const actions = this.collections.userActions.find({ appId: appId, appVersion: { $lt: versionNumber } },
      { fields: { userId: 1 } });
    actions.forEach((action) => {
      const userId = action.userId;
      const updater = {
        timestamp: new Date(),
        isUnread: true,
      };
      const inserter = _.extend({ userId, appUpdates: {} }, updater);

      // Set only the appId that we care about. Use mongo's dot notation to specify only a single
      // field inside of an object to update
      inserter.appUpdates[appId] = updater["appUpdates." + appId] = {
        marketingVersion: marketingVersion,
        packageId: packageId,
        name: name,
        version: versionNumber,
      };

      // We unfortunately cannot upsert because upserts can only have field equality conditions in
      // the query. If we try to upsert, Mongo complaints that "$exists" isn't valid to store.
      if (this.collections.notifications.update(
          { userId: userId, appUpdates: { $exists: true } },
          { $set: updater }) == 0) {
        // Update failed; try an insert instead.
        this.collections.notifications.insert(inserter);
      }
    });

    this.collections.appIndex.update({ _id: appId }, { $set: { hasSentNotifications: true } });

    // In the case where we replaced a previous notification and that was the only reference to the
    // package, we need to clean it up
    this.deleteUnusedPackages(appId);
  };

  SandstormDb.prototype.sendReferralProgramNotification = function (userId) {
    this.collections.notifications.upsert({
      userId: userId,
      referral: true,
    }, {
      userId: userId,
      referral: true,
      timestamp: new Date(),
      isUnread: true,
    });
  };

  SandstormDb.prototype.upgradeGrains =  function (appId, version, packageId, backend) {
    check(appId, String);
    check(version, Match.Integer);
    check(packageId, String);

    const selector = {
      userId: Meteor.userId(),
      appId: appId,
      appVersion: { $lte: version },
      packageId: { $ne: packageId },
    };

    this.collections.grains.find(selector).forEach(function (grain) {
      backend.shutdownGrain(grain._id, grain.userId);
    });

    this.collections.grains.update(selector, {
      $set: { appVersion: version, packageId: packageId, packageSalt: Random.secret() },
    }, { multi: true });
  };

  SandstormDb.prototype.startInstall = function (packageId, url, retryFailed, isAutoUpdated) {
    // Mark package for possible installation.

    const fields = {
      status: "download",
      progress: 0,
      url: url,
      isAutoUpdated: !!isAutoUpdated,
    };

    if (retryFailed) {
      this.collections.packages.update({ _id: packageId, status: "failed" }, { $set: fields });
    } else {
      try {
        fields._id = packageId;
        this.collections.packages.insert(fields);
      } catch (err) {
        console.error("Simultaneous startInstall()s?", err.stack);
      }
    }
  };

  const ValidKeyFingerprint = Match.Where(function (keyFingerprint) {
    check(keyFingerprint, String);
    return !!keyFingerprint.match(/^[0-9A-F]{40}$/);
  });

  SandstormDb.prototype.updateKeybaseProfileAsync = function (keyFingerprint) {
    // Asynchronously fetch the given Keybase profile and populate the KeybaseProfiles collection.

    check(keyFingerprint, ValidKeyFingerprint);

    console.log("fetching keybase", keyFingerprint);

    HTTP.get(
        "https://keybase.io/_/api/1.0/user/lookup.json?key_fingerprint=" + keyFingerprint +
        "&fields=basics,profile,proofs_summary", {
      timeout: 5000,
    }, (err, keybaseResponse) => {
      if (err) {
        console.log("keybase lookup error:", err.stack);
        return;
      }

      if (!keybaseResponse.data) {
        console.log("keybase didn't return JSON? Headers:", keybaseResponse.headers);
        return;
      }

      const profile = (keybaseResponse.data.them || [])[0];

      if (profile) {
        // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
        const record = {
          displayName: (profile.profile || {}).full_name,
          handle: (profile.basics || {}).username,
          proofs: (profile.proofs_summary || {}).all || [],
        };
        // jscs:enable requireCamelCaseOrUpperCaseIdentifiers

        record.proofs.forEach(function (proof) {
          // Remove potentially Mongo-incompatible stuff. (Currently Keybase returns nothing that
          // this would filter.)
          for (let field in proof) {
            // Don't allow field names containing '.' or '$'. Also don't allow sub-objects mainly
            // because I'm too lazy to check the field names recursively (and Keybase doesn't
            // return any objects anyway).
            if (field.match(/[.$]/) || typeof (proof[field]) === "object") {
              delete proof[field];
            }
          }

          // Indicate not verified.
          // TODO(security): Asynchronously verify proofs. Presumably we can borrow code from the
          //   Keybase node-based CLI.
          proof.status = "unverified";
        });

        this.collections.keybaseProfiles.update(keyFingerprint, { $set: record }, { upsert: true });
      } else {
        // Keybase reports no match, so remove what we know of this user. We don't want to remove
        // the item entirely from the cache as this will cause us to repeatedly re-fetch the data
        // from Keybase.
        //
        // TODO(someday): We could perhaps keep the proofs if we can still verify them directly,
        //   but at present we don't have the ability to verify proofs.
        this.collections.keybaseProfiles.update(keyFingerprint,
            { $unset: { displayName: "", handle: "", proofs: "" } }, { upsert: true });
      }
    });
  };

  SandstormDb.prototype.deleteUnusedAccount = function (backend, identityId) {
    // If there is an *unused* account that has `identityId` as a login identity, deletes it.

    check(identityId, String);
    const account = this.collections.users.findOne({ "loginIdentities.id": identityId });
    if (account &&
        account.loginIdentities.length == 1 &&
        account.nonloginIdentities.length == 0 &&
        !this.collections.grains.findOne({ userId: account._id }) &&
        !this.collections.apiTokens.findOne({ accountId: account._id }) &&
        (!account.plan || account.plan === "free") &&
        !(account.payments && account.payments.id) &&
        !this.collections.contacts.findOne({ ownerId: account._id })) {
      this.collections.users.remove({ _id: account._id });
      backend.deleteUser(account._id);
    }
  };

  Meteor.publish("keybaseProfile", function (keyFingerprint) {
    check(keyFingerprint, ValidKeyFingerprint);
    const db = this.connection.sandstormDb;

    const cursor = db.collections.keybaseProfiles.find(keyFingerprint);
    if (cursor.count() === 0) {
      // Fire off async update.
      db.updateKeybaseProfileAsync(keyFingerprint);
    }

    return cursor;
  });

  Meteor.publish("appIndex", function (appId) {
    check(appId, String);
    const db = this.connection.sandstormDb;
    const cursor = db.collections.appIndex.find({ _id: appId });
    return cursor;
  });

  Meteor.publish("userPackages", function () {
    // Users should be able to see packages that are either:
    // 1. referenced by one of their userActions
    // 2. referenced by one of their grains
    const db = this.connection.sandstormDb;

    // Note that package information, once it is in the database, is static. There's no need to
    // reactively subscribe to changes to a package since they don't change. It's also unecessary
    // to reactively remove a package from the client side when it is removed on the server, or
    // when the client stops using it, because the worst case is the client has a small amount
    // of extra info on a no-longer-used package held in memory until they refresh Sandstorm.
    // So, we implement this as a cache: the first time each package ID shows up among the user's
    // stuff, we push the package info to the client, and then we never update it.
    //
    // Alternatively, we could subscribe to each individual package query, but this would waste
    // lots of server-side resources watching for events that will never happen or don't matter.
    const hasPackage = {};
    const refPackage = (packageId) => {
      // Ignore dev apps.
      if (packageId.lastIndexOf("dev-", 0) === 0) return;

      if (!hasPackage[packageId]) {
        hasPackage[packageId] = true;
        const pkg = db.getPackage(packageId);
        if (pkg) {
          this.added("packages", packageId, pkg);
        } else {
          console.error(
              "shouldn't happen: missing package referenced by user's stuff:", packageId);
        }
      }
    };

    // package source 1: packages referred to by actions
    const actions = db.userActions(this.userId);
    const actionsHandle = actions.observe({
      added(newAction) {
        refPackage(newAction.packageId);
      },

      changed(newAction, oldAction) {
        refPackage(newAction.packageId);
      },
    });

    // package source 2: packages referred to by grains directly
    const grains = db.userGrains(this.userId, { includeTrash: true });
    const grainsHandle = grains.observe({
      added(newGrain) {
        // Watch out: DevApp grains can lack a packageId.
        if (newGrain.packageId) {
          refPackage(newGrain.packageId);
        }
      },

      changed(newGrain, oldGrain) {
        // Watch out: DevApp grains can lack a packageId.
        if (newGrain.packageId) {
          refPackage(newGrain.packageId);
        }
      },
    });

    this.onStop(function () {
      actionsHandle.stop();
      grainsHandle.stop();
    });

    this.ready();
  });
}

const processRawFeatureKey = function (featureKey, renewalProblem) {
  // Maps the raw data of a signed feature key to the desired "effective" feature key we should use
  // to govern high-level behavior.
  const processedFeatureKey = _.clone(featureKey);

  if (renewalProblem) {
    processedFeatureKey.renewalProblem = renewalProblem;
  }

  // Hook for future extensibility.
  return processedFeatureKey;
};

if (Meteor.isServer) {
  const processFeatureKeyDoc = doc => {
    if (!doc) return null;
    const buf = new Buffer(doc.value);
    // We use loadSignedFeatureKey from server/feature-key.js.  This should probably get refactored
    // once we can use ES6 modules.
    const rawFeatureKey = loadSignedFeatureKey(buf);
    return processRawFeatureKey(rawFeatureKey, doc.renewalProblem);
  };

  SandstormDb.prototype.currentFeatureKey = function () {
    // Returns an object with all of the current signed feature key properties,
    // or null, if the feature key is missing or not correctly signed.
    const doc = this.collections.featureKey.findOne({ _id: "currentFeatureKey" });
    return processFeatureKeyDoc(doc);
  };

  SandstormDb.prototype.observeFeatureKey = function (callback) {
    // Calls `callback(currentFeatureKey())` whenever the feature key changes. Returns an observe
    // handle (use .stop() to stop observing).

    return this.collections.featureKey.find({ _id: "currentFeatureKey" }).observe({
      added(doc) {
        callback(processFeatureKeyDoc(doc));
      },

      changed(newDoc, oldDoc) {
        if (newDoc.value !== oldDoc.value) {
          callback(processFeatureKeyDoc(newDoc));
        }
      },

      removed() {
        callback(null);
      },
    });
  };
} else {
  SandstormDb.prototype.currentFeatureKey = function () {
    const featureKey = this.collections.featureKey.findOne({ _id: "currentFeatureKey" });
    return processRawFeatureKey(featureKey);
  };
}

if (Meteor.isServer) {
  SandstormDb.prototype.deleteIdentity = function (identityId) {
    check(identityId, String);

    this.removeApiTokens({ "owner.user.identityId": identityId });
    this.collections.contacts.remove({ identityId: identityId });
    Meteor.users.remove({ _id: identityId });
  };

  SandstormDb.prototype.deleteAccount = function (userId, backend) {
    check(userId, String);

    const _this = this;
    const user = Meteor.users.findOne({ _id: userId });
    this.deleteGrains({ userId: userId }, backend, "grain");
    this.collections.userActions.remove({ userId: userId });
    this.collections.notifications.remove({ userId: userId });
    user.loginIdentities.forEach((identity) => {
      if (Meteor.users.find({ $or: [
        { "loginIdentities.id": identity.id },
        { "nonloginIdentities.id": identity.id },
      ], }).count() === 1) {
        // If this is the only account with the identity, then delete it
        _this.deleteIdentity(identity.id);
      }
    });
    user.nonloginIdentities.forEach((identity) => {
      if (Meteor.users.find({ $or: [
        { "loginIdentities.id": identity.id },
        { "nonloginIdentities.id": identity.id },
      ], }).count() === 1) {
        // If this is the only account with the identity, then delete it
        _this.deleteIdentity(identity.id);
      }
    });
    this.collections.contacts.remove({ ownerId: userId });
    backend.deleteUser(userId);
    Meteor.users.remove({ _id: userId });
  };
}

Meteor.methods({
  addUserActions(packageId) {
    check(packageId, String);
    if (!this.userId || !Meteor.user().loginIdentities || !isSignedUpOrDemo()) {
      throw new Meteor.Exception(403, "Must be logged in as a non-guest to add app actions.");
    }

    if (this.isSimulation) {
      // TODO(cleanup): Appdemo code relies on this being simulated client-side but we don't have
      //   a proper DB object to use.
      new SandstormDb().addUserActions(this.userId, packageId, true);
    } else {
      this.connection.sandstormDb.addUserActions(this.userId, packageId);
    }
  },

  removeUserAction(actionId) {
    check(actionId, String);
    if (this.isSimulation) {
      UserActions.remove({ _id: actionId });
    } else {
      if (this.userId) {
        const result = this.connection.sandstormDb.collections.userActions.findAndModify({
          query: { _id: actionId, userId: this.userId },
          remove: true,
        });

        if (!result.ok) {
          throw new Error(`Couldn't remove user action ${actionId}`);
        }

        const action = result.value;
        if (action) {
          this.connection.sandstormDb.deleteUnusedPackages(action.appId);
        }
      }
    }
  },
});
