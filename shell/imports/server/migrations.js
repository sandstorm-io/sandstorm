// Minimal tooling for doing run-at-least-once, ordered migrations.
//
// Because migrations can experience partial failure and likely have
// side-effects, we should be careful to make sure all migrations are
// idempotent and safe to accidentally run multiple times.

import { Meteor } from "meteor/meteor";
import { _ } from "meteor/underscore";
import { Match } from "meteor/check";
import { userPictureUrl, fetchPicture } from "/imports/server/accounts/picture.js";
import { waitPromise } from "/imports/server/async-helpers.js";
import { PRIVATE_IPV4_ADDRESSES, PRIVATE_IPV6_ADDRESSES } from "/imports/constants.js";

const Future = Npm.require("fibers/future");
const Url = Npm.require("url");
const Crypto = Npm.require("crypto");

const updateLoginStyleToRedirect = function (db, backend) {
  const configurations = Package["service-configuration"].ServiceConfiguration.configurations;
  ["google", "github"].forEach(function (serviceName) {
    const config = configurations.findOne({ service: serviceName });
    if (config && config.loginStyle !== "redirect") {
      configurations.update({ service: serviceName }, { $set: { loginStyle: "redirect" } });
    }
  });
};

const enableLegacyOAuthProvidersIfNotInSettings = function (db, backend) {
  // In the before time, Google and Github login were enabled by default.
  //
  // This actually didn't make much sense, required the first user to configure
  // OAuth, and had some trust-the-first-user properties that weren't totally
  // secure.
  //
  // Now, we have admin-token, so we wish to disable all logins by default
  // (since they need to be configured anyway) but since users may have never
  // explicitly told Sandstorm that Google or Github login should be enabled,
  // we can't just use the value in the Settings collection, since it might
  // never have been set.
  //
  // Thus, if the service is configured but absent from Settings, we should
  // explicitly enable it in Settings, and then the rest of the logic can just
  // depend on what value is in Settings and default to false without breaking
  // user installations.
  const configurations = ServiceConfiguration.configurations;
  ["google", "github"].forEach(function (serviceName) {
    const config = configurations.findOne({ service: serviceName });
    const serviceConfig = db.collections.settings.findOne({ _id: serviceName });
    if (config && !serviceConfig) {
      // Only explicitly enable the login service if:
      // 1) the service is already configured
      // 2) there is no sandstorm configuration already present (the user was
      //    using the previous default behavior).
      db.collections.settings.insert({ _id: serviceName, value: true });
    }
  });
};

const denormalizeInviteInfo = function (db, backend) {
  // When a user is invited via a signup token, the `signupKey` field of their user table entry
  // has always been populated to indicate the key they used. This points into the SignupKeys table
  // which has more information about the key, namely a freeform note entered by the admin when
  // they created the key. In the case that the email invite form was used, the note has the form
  // "E-mail invite to <address>".
  //
  // Later, we decided it was useful to indicate in the users table visible to the admin
  // information about the invite terms. Namely, for email invites we want to show the address
  // and for others we want to show the note. To make this efficient, fields `signupNote` and
  // `signupEmail` were added to the users table. We can backfill these values by denormalizing
  // from the SignupKeys table.

  db.collections.users.find().forEach(function (user) {
    if (user.signupKey && (typeof user.signupKey) === "string" && user.signupKey !== "admin") {
      const signupInfo = db.collections.signupKeys.findOne(user.signupKey);
      if (signupInfo && signupInfo.note) {
        const newFields = { signupNote: signupInfo.note };

        const prefix = "E-mail invite to ";
        if (signupInfo.note.lastIndexOf(prefix) === 0) {
          newFields.signupEmail = signupInfo.note.slice(prefix.length);
        }

        db.collections.users.update(user._id, { $set: newFields });
      }
    }
  });
};

const mergeRoleAssignmentsIntoApiTokens = function (db, backend) {
  db.collections.roleAssignments.find().forEach(function (roleAssignment) {
    db.collections.apiTokens.insert({
      grainId: roleAssignment.grainId,
      userId: roleAssignment.sharer,
      roleAssignment: roleAssignment.roleAssignment,
      petname: roleAssignment.petname,
      created: roleAssignment.created,
      owner: {
        user: {
          userId: roleAssignment.recipient,
          title: roleAssignment.title,
        },
      },
    });
  });
};

const fixOasisStorageUsageStats = function (db, backend) {};
// This migration only pertained to Oasis and it was successfully applied there. Since it referred
// to some global variables that we later wanted to remove and/or rename, we've since replaced it
// with a no-op.

const fetchProfilePictures = function (db, backend) {
  db.collections.users.find({}).forEach(function (user) {
    const url = userPictureUrl(user);
    if (url) {
      console.log("Fetching user picture:", url);
      const assetId = fetchPicture(db, url);
      if (assetId) {
        db.collections.users.update(user._id, { $set: { "profile.picture": assetId } });
      }
    }
  });
};

const assignPlans = function (db, backend) {
  // This was a one-time migration intended to be applied on Oasis to existing users.
  // It has run, so we only need this stub function here.
};

const removeKeyrings = function (db, backend) {
  // These blobs full of public keys were not intended to find their way into mongo and while
  // harmless they slow things down because they're huge. Remove them.
  db.collections.packages.update({ "manifest.metadata.pgpKeyring": { $exists: true } },
      { $unset: { "manifest.metadata.pgpKeyring": "" } },
      { multi: true });
};

const useLocalizedTextInUserActions = function (db, backend) {
  function toLocalizedText(newObj, oldObj, field) {
    if (field in oldObj) {
      if (typeof oldObj[field] === "string") {
        newObj[field] = { defaultText: oldObj[field] };
      } else {
        newObj[field] = oldObj[field];
      }
    }
  }

  db.collections.userActions.find({}).forEach(function (userAction) {
    const fields = {};
    toLocalizedText(fields, userAction, "appTitle");
    toLocalizedText(fields, userAction, "title");
    toLocalizedText(fields, userAction, "nounPhrase");
    db.collections.userActions.update(userAction._id, { $set: fields });
  });
};

const verifyAllPgpSignatures = function (db, backend) {
  db.collections.packages.find({}).forEach(function (pkg) {
    try {
      console.log("checking PGP signature for package:", pkg._id);
      const info = waitPromise(backend.cap().tryGetPackage(pkg._id));
      if (info.authorPgpKeyFingerprint) {
        console.log("  " + info.authorPgpKeyFingerprint);
        db.collections.packages.update(pkg._id,
            { $set: { authorPgpKeyFingerprint: info.authorPgpKeyFingerprint } });
      } else {
        console.log("  no signature");
      }
    } catch (err) {
      console.error(err.stack);
    }
  });
};

const splitUserIdsIntoAccountIdsAndIdentityIds = function (db, backend) {
  db.collections.users.find().forEach(function (user) {
    const identity = {};
    let serviceUserId;
    if ("devName" in user) {
      identity.service = "dev";
      serviceUserId = user.devName;
    } else if ("expires" in user) {
      identity.service = "demo";
      serviceUserId = user._id;
    } else if (user.services && "google" in user.services) {
      identity.service = "google";
      if (user.services.google.email && user.services.google.verified_email) { // jscs:ignore requireCamelCaseOrUpperCaseIdentifiers
        identity.verifiedEmail = user.services.google.email;
      }

      serviceUserId = user.services.google.id;
    } else if (user.services && "github" in user.services) {
      identity.service = "github";
      identity.unverifiedEmail = user.services.github.email;
      serviceUserId = user.services.github.id;
    } else if (user.services && "emailToken" in user.services) {
      identity.service = "emailToken";
      identity.verifiedEmail = user.services.emailToken.email;
      serviceUserId = user.services.emailToken.email;
    }

    identity.id = Crypto.createHash("sha256")
        .update(identity.service + ":" + serviceUserId).digest("hex");

    if (user.profile) {
      if (user.profile.name) {
        identity.name = user.profile.name;
      }

      if (user.profile.handle) {
        identity.handle = user.profile.handle;
      }

      if (user.profile.picture) {
        identity.picture = user.profile.picture;
      }

      if (user.profile.pronoun) {
        identity.pronoun = user.profile.pronoun;
      }

      if (user.profile.email) {
        identity.unverifiedEmail = user.profile.email;
      }
    }

    identity.main = true;

    db.collections.users.update(user._id, { $set: { identities: [identity] } });

    db.collections.grains.update({ userId: user._id }, { $set: { identityId: identity.id } }, { multi: true });
    db.collections.sessions.update({ userId: user._id }, { $set: { identityId: identity.id } }, { multi: true });
    db.collections.apiTokens.update({ userId: user._id },
        { $set: { identityId: identity.id } },
        { multi: true });
    db.collections.apiTokens.update({ "owner.user.userId": user._id },
        { $set: { "owner.user.identityId": identity.id } },
        { multi: true });
    db.collections.apiTokens.update({ "owner.grain.introducerUser": user._id },
        { $set: { "owner.grain.introducerIdentity": identity.id } },
        { multi: true });

    while (db.collections.apiTokens.update({
        "requirements.permissionsHeld.userId": user._id,
      }, {
        $set: { "requirements.$.permissionsHeld.identityId": identity.id },
        $unset: { "requirements.$.permissionsHeld.userId": 1 },
      }, {
        multi: true,
      }) > 0);
    // The `$` operator modifies the first element in the array that matches the query. Since
    // there may be many matches, we need to repeat until no documents are modified.

  });

  db.collections.apiTokens.remove({ userInfo: { $exists: true } });
  // We've renamed `Grain.UserInfo.userId` to `Grain.userInfo.identityId`. The only place
  // that this field could show up in the database was in this deprecated, no-longer-functional
  // form of API token.
};

const appUpdateSettings = function (db, backend) {
  db.collections.settings.insert({ _id: "appMarketUrl", value: "https://apps.sandstorm.io" });
  db.collections.settings.insert({ _id: "appIndexUrl", value: "https://app-index.sandstorm.io" });
  db.collections.settings.insert({ _id: "appUpdatesEnabled", value: true });
};

const moveDevAndEmailLoginDataIntoIdentities = function (db, backend) {
  db.collections.users.find().forEach(function (user) {
    if (user.identities.length !== 1) {
      throw new Error("User does not have exactly one identity: ", user);
    }

    const identity = user.identities[0];
    if (Match.test(identity.service, Object)) { return; } // Already migrated.

    const newIdentity = _.pick(identity, "id", "main", "noLogin", "verifiedEmail", "unverifiedEmail");
    newIdentity.profile = _.pick(identity, "name", "handle", "picture", "pronoun");

    const serviceObject = {};
    const fieldsToUnset = {};

    if (identity.service === "dev") {
      serviceObject.name = user.devName;
      fieldsToUnset.devName = 1;
    } else if (identity.service === "emailToken") {
      serviceObject.tokens = user.services.emailToken.tokens;
      serviceObject.email = user.services.emailToken.email;
      fieldsToUnset["services.emailToken"] = 1;
    }

    newIdentity.service = {};
    newIdentity.service[identity.service] = serviceObject;

    const modifier = { $set: { identities: [newIdentity] } };
    if (Object.keys(fieldsToUnset).length > 0) {
      modifier.$unset = fieldsToUnset;
    }

    db.collections.users.update({ _id: user._id }, modifier);
  });
};

const repairEmailIdentityIds = function (db, backend) {
  db.collections.users.find({ "identities.service.emailToken": { $exists: 1 } }).forEach(function (user) {
    if (user.identities.length !== 1) {
      throw new Error("User does not have exactly one identity: ", user);
    }

    const identity = user.identities[0];
    const newIdentity = _.pick(identity, "main", "noLogin", "verifiedEmail", "unverifiedMail",
                               "profile");
    newIdentity.service = { email: identity.service.emailToken };
    newIdentity.id = Crypto.createHash("sha256")
      .update("email:" + identity.service.emailToken.email).digest("hex");

    db.collections.grains.update({ identityId: identity.id }, { $set: { identityId: newIdentity.id } }, { multi: true });
    db.collections.sessions.update({ identityId: identity.id }, { $set: { identityId: newIdentity.id } }, { multi: true });
    db.collections.apiTokens.update({ identityId: identity.id },
        { $set: { identityId: newIdentity.id } },
        { multi: true });
    db.collections.apiTokens.update({ "owner.user.identityId": identity.id },
        { $set: { "owner.user.identityId": newIdentity.id } },
        { multi: true });
    db.collections.apiTokens.update({ "owner.grain.introducerIdentity": identity.id },
        { $set: { "owner.grain.introducerIdentity": newIdentity.id } },
        { multi: true });

    while (db.collections.apiTokens.update({ "requirements.permissionsHeld.identityId": identity.id },
        { $set: { "requirements.$.permissionsHeld.identityId": newIdentity.id } },
        { multi: true }) > 0);

    db.collections.users.update({ _id: user._id }, { $set: { identities: [newIdentity] } });
  });
};

const splitAccountUsersAndIdentityUsers = function (db, backend) {
  db.collections.users.find({ identities: { $exists: true } }).forEach(function (user) {
    if (user.identities.length !== 1) {
      throw new Error("User does not have exactly one identity: ", user);
    }

    const identity = user.identities[0];
    const identityUser = _.pick(user, "createdAt", "lastActive", "expires");
    identityUser._id = identity.id;
    identityUser.profile = identity.profile;
    _.extend(identityUser, _.pick(identity, "unverifiedEmail"));
    identityUser.profile.service = Object.keys(identity.service)[0];

    // Updating this user needs to be a two step process because the `services` field typically
    // contains subfields that are constrained to be unique by Mongo indices.
    identityUser.stagedServices = _.omit(user.services, "resume");
    if (identity.service.dev) {
      identityUser.stagedServices.dev = identity.service.dev;
    } else if (identity.service.email) {
      identityUser.stagedServices.email = identity.service.email;
    }

    const accountUser = _.pick(user, "_id", "createdAt", "lastActive", "expires",
                             "isAdmin", "signupKey", "signupNote", "signupEmail",
                             "plan", "storageUsage", "isAppDemoUser", "appDemoId",
                             "payments", "dailySentMailCount", "hasCompletedSignup");
    accountUser.loginIdentities = [_.pick(identity, "id")];
    accountUser.nonloginIdentities = [];
    if (user.services && user.services.resume) {
      accountUser.services = { resume: user.services.resume };
    }

    accountUser.stashedOldUser = user;

    db.collections.apiTokens.update(
      { identityId: identityUser._id },
      { $set: { accountId: user._id } },
      { multi: true });

    db.collections.users.upsert({ _id: identityUser._id }, identityUser);
    db.collections.users.update({ _id: user._id }, accountUser);
  });

  db.collections.users.find({ stagedServices: { $exists: true } }).forEach(function (identity) {
    db.collections.users.update({ _id: identity._id }, {
      $unset: { stagedServices: 1 },
      $set: { services: identity.stagedServices },
    });
  });
};

const populateContactsFromApiTokens = function (db, backend) {
  db.collections.apiTokens.find({
    "owner.user.identityId": { $exists: 1 },
    accountId: { $exists: 1 },
  }).forEach(function (token) {
    const identityId = token.owner.user.identityId;
    const identity = Meteor.users.findOne({_id: identityId});
    if (identity) {
      const profile = identity.profile;
      SandstormDb.fillInProfileDefaults(identity, profile);
      db.collections.contacts.upsert({ ownerId: token.accountId, identityId: identityId }, {
        ownerId: token.accountId,
        petname: profile && profile.name,
        created: new Date(),
        identityId: identityId,
        profile: profile,
      });
    }
  });
};

const cleanUpApiTokens = function (db, backend) {
  // The `splitUserIdsIntoAccountIdsAndIdentityIds()` migration only added `identityId` in cases
  // where the user still existed in the database.
  db.collections.apiTokens.remove({
    userId: { $exists: true },
    identityId: { $exists: false },
  });
  db.collections.apiTokens.remove({
    "owner.user.userId": { $exists: true },
    "owner.user.identityId": { $exists: false },
  });

  // For a while we were accidentally setting `appIcon` instead of `icon`.
  db.collections.apiTokens.find({
    "owner.user.denormalizedGrainMetadata.appIcon": { $exists: true },
  }).forEach(function (apiToken) {
    const icon = apiToken.owner.user.denormalizedGrainMetadata.appIcon;
    db.collections.apiTokens.update({ _id: apiToken._id }, {
      $set: { "owner.user.denormalizedGrainMetadata.icon": icon },
      $unset: { "owner.user.denormalizedGrainMetadata.appIcon": true },
    });
  });

  // For a while the `identityId` field of child UiView tokens was not getting set.
  function repairChain(parentToken) {
    db.collections.apiTokens.find({
      parentToken: parentToken._id,
      grainId: { $exists: true },
      identityId: { $exists: false },
    }).forEach(function (childToken) {
      db.collections.apiTokens.update({ _id: childToken._id }, { $set: { identityId: parentToken.identityId } });
      repairChain(childToken);
    });
  }

  db.collections.apiTokens.find({
    grainId: { $exists: true },
    identityId: { $exists: true },
    parentToken: { $exists: false },
  }).forEach(repairChain);
};

const initServerTitleAndReturnAddress = function (db, backend) {
  const hostname = Url.parse(process.env.ROOT_URL).hostname;
  db.collections.settings.insert({ _id: "serverTitle", value: hostname });
  db.collections.settings.insert({ _id: "returnAddress", value: "no-reply@" + hostname });
};

const sendReferralNotifications = function (db, backend) {
  if (db.isReferralEnabled()) {
    db.collections.users.find({
      loginIdentities: { $exists: true },
      expires: { $exists: false },
    }, { fields: { _id: 1 } }).forEach(function (user) {
      db.sendReferralProgramNotification(user._id);
    });
  }
};

const assignBonuses = function (db, backend) {
  // This was a one-time migration intended to be applied on Oasis to existing users.
  // It has run, so we only need this stub function here.
};

const splitSmtpUrl = function (db, backend) {
  const smtpUrlSetting = db.collections.settings.findOne({ _id: "smtpUrl" });
  const smtpUrl = smtpUrlSetting ? smtpUrlSetting.value : process.env.MAIL_URL;
  const returnAddress = db.collections.settings.findOne({ _id: "returnAddress" });

  // Default values.
  const smtpConfig = {
    hostname: "localhost",
    port: "25",
    auth: undefined,
    returnAddress: returnAddress.value,
  };

  let parsed;
  try {
    parsed = smtpUrl && Url.parse(smtpUrl);
  } catch (e) {}

  if (parsed) {
    // If there was a SMTP URL previously defined, import its data.
    let auth = undefined;
    if (parsed.auth) {
      const colonIndex = parsed.auth.indexOf(":");
      let user = undefined;
      let pass = undefined;
      if (colonIndex !== -1) {
        user = parsed.auth.slice(0, colonIndex);
        pass = parsed.auth.slice(colonIndex + 1);
      }

      auth = {
        user,
        pass,
      };
    }

    // Override defaults with previous config's values.
    smtpConfig.hostname = parsed.hostname || "localhost";
    smtpConfig.port = parsed.port || "25";
    smtpConfig.auth = auth;
  }

  db.collections.settings.upsert({ _id: "smtpConfig" }, { value: smtpConfig });
  db.collections.settings.remove({ _id: "returnAddress" });
  db.collections.settings.remove({ _id: "smtpUrl" });
};

const smtpPortShouldBeNumber = function (db, backend) {
  const entry = db.collections.settings.findOne({ _id: "smtpConfig" });
  if (entry) {
    const setting = entry.value;
    if (setting.port) {
      setting.port = _.isNumber(setting.port) ? setting.port : parseInt(setting.port);
      db.collections.settings.upsert({ _id: "smtpConfig" }, { value: setting });
    }
  }
};

const consolidateOrgSettings = function (db, backend) {
  const settings = db.collections.settings;
  const orgGoogleDomain = settings.findOne({ _id: "organizationGoogle" });
  const orgEmailDomain = settings.findOne({ _id: "organizationEmail" });
  const orgLdap = settings.findOne({ _id: "organizationLdap" });
  const orgSaml = settings.findOne({ _id: "organizationSaml" });

  const orgMembership = {
    google: {
      enabled: orgGoogleDomain ? !!orgGoogleDomain.value : false,
      domain: orgGoogleDomain ? orgGoogleDomain.value : "",
    },
    email: {
      enabled: orgEmailDomain ? !!orgEmailDomain.value : false,
      domain: orgEmailDomain ? orgEmailDomain.value : "",
    },
    ldap: {
      enabled: orgLdap ? orgLdap.value : false,
    },
    saml: {
      enabled: orgSaml ? orgSaml.value : false,
    },
  };

  settings.upsert({ _id: "organizationMembership" }, { value: orgMembership });
  settings.remove({ _id: "organizationGoogle" });
  settings.remove({ _id: "organizationEmail" });
  settings.remove({ _id: "organizationLdap" });
  settings.remove({ _id: "organizationSaml" });
};

const unsetSmtpDefaultHostnameIfNoUsersExist = function (db, backend) {
  // We don't actually want to have the default hostname "localhost" set.
  // If the user has already finished configuring their server, then this migration should do
  // nothing (since we might break their deployment), but for new installs (which will have no users
  // at the time this migration runs) we'll unset the hostname if it's still the previously-filled
  // default value.
  const hasUsers = db.collections.users.findOne();
  if (!hasUsers) {
    const entry = db.collections.settings.findOne({ _id: "smtpConfig" });
    const smtpConfig = entry.value;
    if (smtpConfig.hostname === "localhost") {
      smtpConfig.hostname = "";
      db.collections.settings.upsert({ _id: "smtpConfig" }, { value: smtpConfig });
    }
  }
};

const extractLastUsedFromApiTokenOwner = function (db, backend) {
  // We used to store lastUsed as a field on owner.user.  It makes more sense to store lastUsed on
  // the apiToken as a whole.  This migration hoists such values from owner.user onto the apiToken
  // itself.
  db.collections.apiTokens.find({ "owner.user": { $exists: true } }).forEach(function (token) {
    const lastUsed = token.owner.user.lastUsed;
    db.collections.apiTokens.update({ _id: token._id }, {
      $set: { lastUsed: lastUsed },
      $unset: { "owner.user.lastUsed": true },
    });
  });
};

const setUpstreamTitles = function (db, backend) {
  // Initializes the `upstreamTitle` and `renamed` fields of `ApiToken.owner.user`.

  const apiTokensRaw = db.collections.apiTokens.rawCollection();
  const aggregateApiTokens = Meteor.wrapAsync(apiTokensRaw.aggregate, apiTokensRaw);

  // First, construct a list of all *shared* grains. We will need to do a separate update()
  // for each of these, so we'd like to skip those which have nothing to update.
  const grainIds = aggregateApiTokens([
    { $match: { "owner.user": { $exists: true }, grainId: { $exists: true } } },
    { $group: { _id: "$grainId" } },
  ]).toArray().await().map(grain => grain._id);

  let count = 0;
  db.collections.grains.find({ _id: { $in: grainIds } }, { fields: { title: 1 } }).forEach((grain) => {
    if (count % 100 == 0) {
      console.log(count + " / " + grainIds.length);
    }

    ++count;

    // For ApiTokens whose petname titles do not match the upstream title, we need to set
    // `upstreamTitle` and `renamed`. We have no way of knowing which of the two names was the
    // original name, so we don't know whether it was the owner or the receiver who renamed their
    // copy post-sharaing. We assume it was the owner, because:
    // 1. It's probably unusual for people to try to rename a grain they don't own.
    // 2. This results in UI that is reasonably non-confusing even if we guessed wrong. Namely,
    //    the user sees "Owner's title (was: User's title)", which is reasonably OK even if it
    //    was the user who had renamed their copy. They can rename it again if they like. On the
    //    other hand, if we guessed wrongly in the other direction, the user would see
    //    "User's title (renamed from: Owners title)", which would be wrong if it was in fact the
    //    owner who renamed post-sharing.
    db.collections.apiTokens.update({
      grainId: grain._id,
      "owner.user.title": { $exists: true, $ne: grain.title },
    }, { $set: { "owner.user.upstreamTitle": grain.title } }, { multi: true });
  });
};

const markAllRead = function (db, backend) {
  // Mark as "read" all grains and tokens that predate the creation of read/unread status.
  // Otherwise it's pretty annoying to see all your old grains look like they have activity.

  db.collections.grains.update({}, { $set: { ownerSeenAllActivity: true } }, { multi: true });
  db.collections.apiTokens.update({ "owner.user": { $exists: true } },
      { $set: { "owner.user.seenAllActivity": true } },
      { multi: true });
};

const clearAppIndex = function (db, backend) {
  // Due to a bug in the app update code, some app update notifications that the user accepted
  // around July 9-16, 2016 may not have applied. We have no way of knowing exactly which updates
  // the user accepted but didn't receive. Instead, to recover, we are clearing the local cache of
  // the app index one time. This way, the next time the app index is re-fetched, the server will
  // interpret all of the apps in the index as updated and will re-deliver notifications to
  // everyone. This may mean users get notifications that they previously dismissed, but they can
  // click "dismiss" again easily enough.

  db.collections.appIndex.remove({});
};

const assignEmailVerifierIds = function (db, backend) {
  // Originally, the ID of an EmailVerifier was actually the _id of the root token from which it
  // was restored. This was broken, though: Conceptually, it meant that you couldn't have a working
  // EmailVerifier that had not been restore()d from disk. In practice, that wasn't a problem due
  // to the fact that powerbox selections always involve a restore(), but a different problem
  // existed: the capability returned by claimRequest() would return one ID, but after save()ing
  // and restore()ing that capability, the ID would be different, because the new capability would
  // be a copy -- not a child -- of the original. Additionally, the whole thing made various code
  // ugly because it was puncturing layers of abstraction. So, we switched to doing the right
  // thing: assigning an ID to the EmailVerifier on first creation and storing it separately.

  db.collections.apiTokens.find({ "frontendRef.emailVerifier": { $exists: true } }).forEach(token => {
    db.collections.apiTokens.update(token._id, { $set: { "frontendRef.emailVerifier.id": token._id } });
  });
};

const startPreinstallingApps = function (db, backend) {
  // This isn't really a normal migration. It will run only on brand new servers, and it has to
  // run after the `clearAppIndex` migration because it relies on populating AppIndex.

  const startPreinstallingAppsHelper = function () {
    db.updateAppIndex();

    const preinstalledApps = db.collections.appIndex.find({ _id: {
      $in: db.getProductivitySuiteAppIds().concat(
        db.getSystemSuiteAppIds()), },
    }).fetch();
    const appAndPackageIds = _.map(preinstalledApps, (app) => {
      return {
        appId: app.appId,
        packageId: app.packageId,
      };
    });

    db.setPreinstalledApps(appAndPackageIds);
  };

  if (!Meteor.settings.public.isTesting && !db.allowDevAccounts()) {
    // We want preinstalling apps to run async and not block startup.
    Meteor.setTimeout(startPreinstallingAppsHelper, 0);
  }
};

const setNewServer = function (db, backend) {
  // This migration only applies to "old" servers. New servers will set
  // new_server_migrations_applied to false before any migrations run.
  if (!db.collections.migrations.findOne({ _id: "new_server_migrations_applied" })) {
    db.collections.migrations.insert({ _id: "new_server_migrations_applied", value: true });
  }
};

const addMembraneRequirementsToIdentities = function (db, backend) {
  const query = {
    "frontendRef.identity": { $exists: true, },
    "owner.grain.grainId": { $exists: true, },
    "requirements.0": { $exists: false, },
  };

  db.collections.apiTokens.find(query).map((apiToken) => {
    db.collections.apiTokens.update(
      { _id: apiToken._id },
      {
        $push: {
          requirements: {
            permissionsHeld: {
              grainId: apiToken.owner.grain.grainId,
              identityId: apiToken.frontendRef.identity,
              permissions: [],
            },
          },
        },
      }
    );
  });
};

const addEncryptionToFrontendRefIpNetwork = function (db, backend) {
  db.collections.apiTokens.find({ "frontendRef.ipNetwork": true }).map((apiToken) => {
    db.collections.apiTokens.update(
      { _id: apiToken._id },
      { $set: { "frontendRef.ipNetwork": { encryption: { none: null } } } });
  });
};

function backgroundFillInGrainSizes(db, backend) {
  // Fill in sizes for all grains that don't have them. Since computing a grain size requires a
  // directory walk, we don't want to do them all at once. Instead, we compute one a second until
  // all grains have sizes.

  try {
    const grain = db.collections.grains.findOne({ size: { $exists: false } }, { fields: { _id: 1, userId: 1 } });

    if (grain) {
      // Compute size!
      try {
        const result = waitPromise(backend.cap().getGrainStorageUsage(
            grain.userId, grain._id));
        db.collections.grains.update({ _id: grain._id, size: { $exists: false } },
            { $set: { size: parseInt(result.size) } });
      } catch (err) {
        if (err.kjType === "failed") {
          // Backend had a problem. Maybe the grain doesn't actually exist on disk and the database
          // is messed up. We'll set the size to zero and move on.
          console.error("Error while backfilling grain size for", grain._id, ":", err.stack);
          db.collections.grains.update({ _id: grain._id, size: { $exists: false } }, { $set: { size: 0 } });
        } else {
          // Rethrow on disconnected / overloaded / unimplemented.
          throw err;
        }
      }

      // Do another one in a second.
      Meteor.setTimeout(backgroundFillInGrainSizes.bind(this, db, backend), 1000);
    }
  } catch (err) {
    // We'll just stop for now, to avoid spamming logs if this error persists. Next time the server
    // restarts, the migration will continue.
    console.error("Error while backfilling grain sizes:", err.stack);
  }
}

function removeFeatureKeys(db, backend) {
  // Remove obsolete data related to the Sandstorm for Work paywall, which was eliminated.

  db.notifications.remove({ "admin.type": "cantRenewFeatureKey" });
  db.notifications.remove({ "admin.type": "trialFeatureKeyExpired" });
}

function setIpBlacklist(db, backend) {
  if (Meteor.settings.public.isTesting) {
    db.collections.settings.insert({ _id: "ipBlacklist", value: "192.168.0.0/16" });
  } else {
    const defaultIpBlacklist = PRIVATE_IPV4_ADDRESSES.concat(PRIVATE_IPV6_ADDRESSES).join("\n");
    db.collections.settings.insert({ _id: "ipBlacklist", value: defaultIpBlacklist });
  }
}

function getUserIdentityIds(user) {
  // Formerly SandstormDb.getUserIdentityIds(), from before the identity refactor.

  if (user && user.loginIdentities) {
    return _.pluck(user.nonloginIdentities.concat(user.loginIdentities), "id").reverse();
  } else {
    return [];
  }
}

function notifyIdentityChanges(db, backend) {
  // Notify users who might be affected by the identity model changes.
  //
  // Two types of users are affected:
  // - Users who have multiple identities with differing names.
  // - Users who have identities that are shared with other users.
  //
  // However, the second group seems like it must be a subset of the first group. So we only check
  // for the first.

  const names = {};
  Meteor.users.find({ "profile.name": { $exists: true } }, { fields: { "profile.name": 1 } })
      .forEach(user => {
    names[user._id] = user.profile.name;
  });

  Meteor.users.find({ loginIdentities: { $exists: true } },
                    { fields: { loginIdentities: 1, nonloginIdentities: 1 } }).forEach(user => {
    let previousName = null;
    let needsNotification = false;
    getUserIdentityIds(user).forEach(identityId => {
      const name = names[identityId];
      if (!name || (previousName && previousName !== name)) {
        needsNotification = true;
      }

      previousName = name;
    });

    if (needsNotification) {
      db.collections.notifications.upsert({
        userId: user._id,
        identityChanges: true,
      }, {
        userId: user._id,
        identityChanges: true,
        timestamp: new Date(),
        isUnread: true,
      });
    }
  });
}

Mongo.Collection.prototype.ensureDroppedIndex = function () {
  try {
    this._dropIndex.apply(this, arguments);
  } catch (err) {
    // ignore (probably, index didn't exist)
  }
}

function onePersonaPerAccountPreCleanup(db, backend) {
  // Removes some already-obsolete data from the database before attempting the
  // one-persona-per-account migration.

  // Remove long-obsolete index.
  Meteor.users.ensureDroppedIndex({ "identities.id": 1 });

  // Remove `stashedOldUser`, which is long-obsolete.
  Meteor.users.update({ stashedOldUser: { $exists: true } },
                      { $unset: { stashedOldUser: 1 } },
                      { multi: true });

  // Remove ApiTokens which have an identityId but not an accountId. These tokens could only exist
  // if they were created in between `splitUserIdsIntoAccountIdsAndIdentityIds` and
  // `splitAccountUsersAndIdentityUsers` (late 2015), and if, during that time, the user who
  // created the ApiToken was deleted (which, at the time, was only possible for demo users, or
  // through direct database manipulation). These tokens are all invalid and couldn't possibly have
  // been used since the user was deleted.
  db.collections.apiTokens.remove({ identityId: { $exists: true }, accountId: { $exists: false } });

  // Remove ApiTokens that have the obsolete owner.grain.introducerIdentity field as these tokens
  // are not allowed to be restored anyway.
  db.collections.apiTokens.remove({ "owner.grain.introducerIdentity": { $exists: true } });

  // Make sure all demo credentials have a "services.demo" entry, to be consistent with all other
  // service types.
  Meteor.users.update({ "profile.service": "demo" },
                      { $set: { "services.demo": {} } },
                      { multi: true });

}

function forEachProgress(title, cursor, func) {
  console.log(title);

  const total = cursor.count();
  let count = 0;

  cursor.forEach(doc => {
    func(doc);
    if (++count % 100 == 0) console.log("   ", count, "/", total);
  });
}

function onePersonaPerAccount(db, backend) {
  // THIS IS A MAJOR CHANGE: https://sandstorm.io/news/2017-05-08-refactoring-identities

  console.log("** Migrating to new identity model! **");
  console.log("see: https://sandstorm.io/news/2017-05-08-refactoring-identities");

  console.log("tagging accounts...");
  Meteor.users.update({ type: { $exists: false }, loginIdentities: { $exists: true } },
                      { $set: { type: "account" } },
                      { multi: true });

  console.log("tagging credentials...");
  Meteor.users.update({ type: { $exists: false }, profile: { $exists: true } },
                      { $set: { type: "credential" } },
                      { multi: true });

  // Map each identity ID to the list of connected accounts.
  console.log("building identity map...");
  const identityToAccount = {};
  const needSort = [];
  Meteor.users.find({ type: "account" }).forEach(user => {
    const userInfo = { id: user._id, lastActive: user.lastActive || user.createdAt };

    function handleIdentity(identity) {
      if (!identityToAccount[identity.id]) {
        identityToAccount[identity.id] = [userInfo];
      } else {
        const list = identityToAccount[identity.id];
        if (list.length == 1) needSort.push(list);
        list.push(userInfo);
      }
    }
    user.loginIdentities.forEach(handleIdentity);
    user.nonloginIdentities.forEach(handleIdentity);
  });

  // For identities attached to multiple accounts, we want the most-recently-active account to sort
  // first. In cases where we need to replace an identity with exactly one account, we'll use that
  // first option.
  needSort.forEach(item => {
    item.sort((a, b) => {
      if (a.lastActive > b.lastActive) {
        return -1;
      } else if (a.lastActive < b.lastActive) {
        return 1;
      } else {
        return 0;
      }
    });
  });

  function accountForIdentity(identityId) {
    const ids = identityToAccount[identityId];
    if (ids) {
      return ids[0].id;
    } else {
      console.error("no such identity:", identityId);
      return "invalid-" + identityId;
    }
  }

  function accountListForIdentity(identityId) {
    const ids = identityToAccount[identityId];
    if (ids) {
      return ids.map(i => i.id);
    } else {
      console.error("no such identity:", identityId);
      return ["invalid-" + identityId];
    }
  }

  forEachProgress("migrating users...",
      Meteor.users.find({ type: "account" }),
      user => {
    // Fetch all the user's login identities.
    const identities = Meteor.users.find(
        { _id: { $in: user.loginIdentities.map(identity => identity.id) },
          profile: { $exists: true } }).fetch();

    // Fill out the profiles for each identity.
    identities.forEach(identity => {
      SandstormDb.fillInProfileDefaults(identity, identity.profile);
    });

    // Find the best profile among them.
    let profile;
    if (identities.length == 0) {
      // no profiles???
      profile = null;
    } else if (identities.length == 1) {
      profile = identities[0].profile;
    } else {
      // Multi-identity user. Try to find the "best" identity.

      let maxScore = -1;

      identities.forEach(identity => {
        // Count total grains using this identity.
        let score =
            db.collections.grains.find({ userId: user._id, identityId: identity._id }).count() +
            db.collections.apiTokens.find({ "owner.user.identityId": identity._id }).count();

        // Avoid choosing demo user, unless they've really used it a lot.
        if (identity.profile.name !== "Demo User") {
          score += 10;
        }

        if (score > maxScore) {
          profile = identity.profile;
          maxScore = score;
        }
      });
    }

    if (profile) {
      delete profile.service;
    } else {
      console.warn("no suitable profile found for user account:", user._id);
      profile = {
        name: "Unknown",
        handle: "unknown",
        pronoun: "neutral",
        identicon: Crypto.randomBytes(32).toString("hex"),
      };
    }

    const mod = { profile };

    // Also figure out referrals.
    const referrers = Meteor.users.find(
        { _id: { $in: getUserIdentityIds(user) }, referredBy: { $exists: true } },
        { fields: { referredBy: 1 } })
        .map(id => id.referredBy);
    if (referrers.length > 0) {
      mod.referredBy = referrers[0];
    }

    if (user.referredIdentityIds) {
      mod.referredAccountIds = user.referredIdentityIds.map(accountForIdentity);
    }

    Meteor.users.update({ _id: user._id }, { $set: mod });
  });

  forEachProgress("migrating ApiTokens...",
      db.collections.apiTokens.find({ "owner.user.identityId": { $exists: true } }),
      token => {
    const accounts = accountListForIdentity(token.owner.user.identityId);

    db.collections.apiTokens.update({ _id: token._id },
        { $set: { "owner.user.accountId": accounts[0] } });

    if (accounts.length > 1 && token.grainId && token.accountId) {
      // Shared to an identity that has multiple accounts. We need to denormalize the share to
      // target each account individually.
      //
      // Note: A token with owner.user.identityId is always a UiView share token and so always has
      //   accountId and grainId. There are zero counterexamples in Oasis. But if a counterexample
      //   existed, the code below might compound the confusion, so we skip it.

      delete token._id;
      accounts.slice(1).forEach(account => {
        // For idempotency purposes, don't insert if a similar token already exists.
        if (!db.collections.apiTokens.findOne({
              grainId: token.grainId,
              accountId: token.accountId,
              "owner.user.accountId": account
            })) {
          token.owner.user.accountId = account;
          db.collections.apiTokens.insert(token);
        }
      });
    }
  });

  forEachProgress("migrating membrane requirements...",
      db.collections.apiTokens.find({ "requirements.permissionsHeld.identityId": { $exists: true } }),
      token => {
    token.requirements.forEach(requirement => {
      if (requirement.permissionsHeld && requirement.permissionsHeld.identityId) {
        requirement.permissionsHeld.accountId =
            accountForIdentity(requirement.permissionsHeld.identityId);
      }
    });

    db.collections.apiTokens.update({ _id: token._id },
        { $set: { requirements: token.requirements } });
  });

  forEachProgress("migrating identity capabilities...",
      db.collections.apiTokens.find({ "frontendRef.identity": { $exists: true } }),
      token => {
    db.collections.apiTokens.update({ _id: token._id },
        { $set: { "frontendRef.identity": accountForIdentity(token.frontendRef.identity) } });
  });

  forEachProgress("migrating contacts...",
      db.collections.contacts.find(),
      contact => {
    db.collections.contacts.update({ _id: contact._id },
        { $set: { accountId: accountForIdentity(contact.identityId) } });
  });

  forEachProgress("migrating notifications...",
      db.collections.notifications.find({ initiatingIdentity: { $exists: true } }),
      notification => {
    db.collections.notifications.update({ _id: notification._id },
        { $set: { initiatingAccount: accountForIdentity(notification.initiatingIdentity) } });
  });

  forEachProgress("migrating desktop notifications...",
      db.collections.desktopNotifications.find(
          { "appActivity.user.identityId": { $exists: true } }),
      notification => {
    db.collections.desktopNotifications.update({ _id: notification._id },
        { $set: { "appActivity.user.accountId":
              accountForIdentity(notification.appActivity.user.identityId) } });
  });

  forEachProgress("migrating subscriptions...",
      db.collections.activitySubscriptions.find({ identityId: { $exists: true } }),
      subscription => {
    db.collections.activitySubscriptions.update({ _id: subscription._id },
        { $set: { accountId: accountForIdentity(subscription.identityId) } });
  });
}

function onePersonaPerAccountPostCleanup(db, backend) {
  // Drop obsolete indices.
  db.collections.apiTokens.ensureDroppedIndex({ "owner.user.identityId": 1 });
  db.collections.activitySubscriptions.ensureDroppedIndex({ "identityId": 1 });
  Meteor.users.ensureDroppedIndex({ "loginIdentities.id": 1 });
  Meteor.users.ensureDroppedIndex({ "nonloginIdentities.id": 1 });

  Meteor.users.update({ type: "account" },
      { $rename: { loginIdentities: "loginCredentials",
                   nonloginIdentities: "nonloginCredentials" },
        $unset: { referredIdentityIds: 1 } },
      { multi: true });

  // Note that we intentionally don't unset profiles from credentials for now, as this is a place
  // where we could legitimately be losing data since only of the user's identity profiles gets
  // promoted to their account. We could remove them in a later pass, once we're sure we no longer
  // need that data. (Also unclear if Meteor's accounts system will get confused if profiles
  // disappear...) (Also SansdtormDb.fillInIntrinsicName() is specific to credentials and still
  // reads the profile a bit...)

  db.collections.notifications.update({},
      { $unset: { initiatingIdentity: 1 }},
      { multi: true });

  db.collections.apiTokens.update({ identityId: { $exists: true } },
      { $unset: { identityId: 1 } },
      { multi: true });

  db.collections.apiTokens.update({ "requirements.permissionsHeld.identityId": { $exists: true } },
      { $unset: { "requirements.permissionsHeld.identityId": 1 } },
      { multi: true });
}

// TODO(cleanup): Delete profiles from credentials. (Make sure nothing depends on them.)
// TODO(cleanup): Delete all demo credentials since they aren't really needed anymore. Remove them
//   from associated account nonloginCredentials.

function cleanupBadExpiresIfUnused(db, backend) {
  // A bug in version 0.226 / 0.227 would set expiresIfUnused to a number instead of a Date. Just
  // delete all such tokens since they are probably expired by now.
  db.collections.apiTokens.remove({expiresIfUnused: {$type: 1}});
}

// This must come after all the functions named within are defined.
// Only append to this list!  Do not modify or remove list entries;
// doing so is likely change the meaning and semantics of user databases.
const MIGRATIONS = [
  updateLoginStyleToRedirect,
  enableLegacyOAuthProvidersIfNotInSettings,
  denormalizeInviteInfo,
  mergeRoleAssignmentsIntoApiTokens,
  fixOasisStorageUsageStats,
  fetchProfilePictures,
  assignPlans,
  removeKeyrings,
  useLocalizedTextInUserActions,
  verifyAllPgpSignatures,
  splitUserIdsIntoAccountIdsAndIdentityIds,
  appUpdateSettings,
  moveDevAndEmailLoginDataIntoIdentities,
  repairEmailIdentityIds,
  splitAccountUsersAndIdentityUsers,
  populateContactsFromApiTokens,
  cleanUpApiTokens,
  initServerTitleAndReturnAddress,
  sendReferralNotifications,
  assignBonuses,
  splitSmtpUrl,
  smtpPortShouldBeNumber,
  consolidateOrgSettings,
  unsetSmtpDefaultHostnameIfNoUsersExist,
  extractLastUsedFromApiTokenOwner,
  setUpstreamTitles,
  markAllRead,
  clearAppIndex,
  assignEmailVerifierIds,
  setNewServer,
  addMembraneRequirementsToIdentities,
  addEncryptionToFrontendRefIpNetwork,
  setIpBlacklist,
  notifyIdentityChanges,
  onePersonaPerAccountPreCleanup,
  onePersonaPerAccount,
  onePersonaPerAccountPostCleanup,
  cleanupBadExpiresIfUnused,
];

const NEW_SERVER_STARTUP = [
  startPreinstallingApps,
];

const migrateToLatest = function (db, backend) {
  if (Meteor.settings.replicaNumber) {
    // This is a replica. Wait for the first replica to perform migrations.

    console.log("Waiting for migrations on replica zero...");

    const done = new Future();
    const change = function (doc) {
      console.log("Migrations applied elsewhere: " + doc.value + "/" + MIGRATIONS.length);
      if (doc.value >= MIGRATIONS.length) done.return();
    };

    const observer = db.collections.migrations.find({ _id: "migrations_applied" }).observe({
      added: change,
      changed: change,
    });

    const newServerDone = new Future();
    const newServerChange = function (doc) {
      if (doc.value) {
        console.log("New server migrations applied elsewhere");
        newServerDone.return();
      }
    };

    const newServerObserver = db.collections.migrations.find({ _id: "new_server_migrations_applied" }).observe({
      added: newServerChange,
      changed: newServerChange,
    });

    done.wait();
    observer.stop();
    newServerDone.wait();
    newServerObserver.stop();
    console.log("Migrations have completed on replica zero.");
  } else {
    const applied = db.collections.migrations.findOne({ _id: "migrations_applied" });
    let start;
    if (!applied) {
      // Migrations table is not yet seeded with a value.  This means it has
      // applied 0 migrations.  Persist this.
      db.collections.migrations.insert({ _id: "migrations_applied", value: 0 });
      start = 0;

      // This also means this is a brand new server
      db.collections.migrations.insert({ _id: "new_server_migrations_applied", value: false });
    } else {
      start = applied.value;
    }

    console.log("Migrations already applied: " + start + "/" + MIGRATIONS.length);

    for (let i = start; i < MIGRATIONS.length; i++) {
      // Apply migration i, then record that migration i was successfully run.
      console.log("Applying migration " + (i + 1));
      MIGRATIONS[i](db, backend);
      db.collections.migrations.update({ _id: "migrations_applied" }, { $set: { value: i + 1 } });
      console.log("Applied migration " + (i + 1));
    }

    if (!db.collections.migrations.findOne({ _id: "new_server_migrations_applied" }).value) {
      // new_server_migrations_applied is guaranteed to exist since we have a migration that
      // ensures it.
      for (let i = 0; i < NEW_SERVER_STARTUP.length; i++) {
        console.log("Running new server startup function " + (i + 1));
        NEW_SERVER_STARTUP[i](db, backend);
        console.log("Running new server startup function " + (i + 1));
      }

      db.collections.migrations.update({ _id: "new_server_migrations_applied" }, { $set: { value: true } });
    }

    // Start background migrations.
    backgroundFillInGrainSizes(db, backend);
  }
};

export { migrateToLatest };
