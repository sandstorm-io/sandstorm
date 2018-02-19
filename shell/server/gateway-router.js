// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2017 Sandstorm Development Group, Inc. and contributors
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

const GatewayRouter = Capnp.importSystem("sandstorm/backend.capnp").GatewayRouter;
const ApiSession = Capnp.importSystem("sandstorm/api-session.capnp").ApiSession;
const WebSession = Capnp.importSystem("sandstorm/web-session.capnp").WebSession;
const SystemPersistent = Capnp.importSystem("sandstorm/supervisor.capnp").SystemPersistent;
const Powerbox = Capnp.importSystem("sandstorm/powerbox.capnp");

import { inMeteor, waitPromise } from "/imports/server/async-helpers.js";
const Crypto = Npm.require("crypto");
const Dns = Npm.require("dns");

const SESSION_PROXY_TIMEOUT = 60000;
const DNS_CACHE_TTL_SECONDS = 30;

currentTlsKeysCallback = null;

class PermissionsObserver {
  constructor() {
    this.invalidatedPromise = new Promise((resolve, reject) => {
      this.invalidate = resolve;
    });
  }

  close() {
    this.invalidate();
  }

  dropWhenRevoked(handle) {
    this.whenRevoked(() => handle.close());
  }

  whenRevoked(callback) {
    this.invalidatedPromise.then(callback);
  }
};

function boolListToBuffer(bools) {
  const numBytes = Math.ceil(bools.length / 8);
  const buf = new Buffer(numBytes);
  for (let ii = 0; ii < numBytes; ++ii) {
    buf[ii] = 0;
  }

  for (let ii = 0; ii < bools.length; ++ii) {
    const byteNum = Math.floor(ii / 8);
    const bitNum = ii % 8;
    if (bools[ii]) {
      buf[byteNum] = (buf[byteNum] | (1 << bitNum));
    }
  }

  return buf;
}

function validateWebkey(apiToken, refreshedExpiration) {
  // Validates that `apiToken` is a valid UiView webkey, throwing an exception if it is not. If
  // `refreshedExpiration` is set and if the token has an `expiresIfUnused` field, then the
  // `expiresIfUnused` field is reset to `refreshedExpiration`.

  // TODO(cleanup): Don't use 403, use a message code. Need to update grain-client.js.
  if (!apiToken) {
    throw new Meteor.Error(403, "Invalid authorization token");
  }

  if (apiToken.revoked) {
    throw new Meteor.Error(403, "Authorization token has been revoked");
  }

  if (apiToken.owner && !("webkey" in apiToken.owner)) {
    throw new Meteor.Error(403, "Unauthorized to open non-webkey token.");
  }

  if (apiToken.expires && apiToken.expires.getTime() <= Date.now()) {
    throw new Meteor.Error(403, "Authorization token expired");
  }

  if (apiToken.expiresIfUnused) {
    if (apiToken.expiresIfUnused.getTime() <= Date.now()) {
      throw new Meteor.Error(403, "Authorization token expired");
    } else if (refreshedExpiration) {
      ApiTokens.update(apiToken._id, { $set: { expiresIfUnused: refreshedExpiration } });
    } else {
      // It's getting used now, so clear the expiresIfUnused field.
      ApiTokens.update(apiToken._id, { $set: { expiresIfUnused: null } });
    }
  }

  if (apiToken.objectId || apiToken.frontendRef) {
    throw new Meteor.Error(403, "ApiToken refers to a non-webview Capability.");
  }
};

function getUiViewAndUserInfo(grainId, vertex, accountId, identityId, sessionId, observer) {
  if (!accountId && globalDb.getOrganizationDisallowGuests()) {
    throw new Meteor.Error("no-guests", "server doesn't allow guest access");
  }
  // TODO(now): Observe the "no-guests" policy and revoke if it is turned on.

  const grain = Grains.findOne(grainId);
  if (!grain) {
    throw new Meteor.Error("no-such-grain", "grain has been deleted");
  } else if (grain.trashed) {
    throw new Meteor.Error("grain-is-in-trash", "grain is in trash");
  } else if (grain.suspended) {
    throw new Meteor.Error("grain-owner-suspended", "grain owner has been suspended");
  }
  // TODO(now): Observe the grain lookup to see if it becomes trashed or suspended, or if it
  //   switches from old to new sharing model.

  let userInfo = null;
  if (accountId) {
    // If accountId is non-null, we're revealing identity. But if we didn't compute the identity ID
    // yet, we need to do that now.
    identityId = identityId || globalDb.getOrGenerateIdentityId(accountId, grain);

    const user = Meteor.users.findOne({ _id: accountId });
    if (!user) {
      throw new Error("user account deleted");
    }

    SandstormDb.fillInPictureUrl(user);

    // TODO(now): What happens here when the user is accessing an unredeemed token but revealing
    //   their identity? Should this requirement be based on `vertex` instead of `accountId`?
    const idCapRequirement = {
      permissionsHeld: { accountId, grainId },
    };

    userInfo = {
      displayName: { defaultText: user.profile.name },
      preferredHandle: user.profile.handle,
      identityId: new Buffer(identityId, "hex"),
      identity: makeIdentity(user._id, [idCapRequirement]),
      pictureUrl: user.profile.pictureUrl,
      pronouns: user.profile.pronoun || undefined,
    };
  } else {
    userInfo = {
      displayName: { defaultText: "Anonymous User" },
      preferredHandle: "anonymous",
    };
  }

  // Verify that we have permission to start up this grain. We can't do the full permission
  // check until we've obtained the grain's ViewInfo, which requires starting it, so we have to
  // check for permission to start the grain first.
  if (!SandstormPermissions.mayOpenGrain(globalDb, vertex)) {
    throw new Meteor.Error("access-denied", "access denied");
  }

  let uiView;
  const viewInfo = globalBackend.useGrain(grainId, supervisor => {
    uiView = supervisor.getMainView().view;
    return uiView.getViewInfo();
  }).catch(error => {
    if (error.kjType === "failed" || error.kjType === "unimplemented") {
      // Method not implemented.
      // TODO(apibump): Don't treat 'failed' as 'unimplemented'. Unfortunately, old apps built
      //   with old versions of Cap'n Proto don't throw 'unimplemented' exceptions, so we have
      //   to accept 'failed' here at least until the next API bump.
      return null;
    } else {
      throw error;
    }
  }).await();

  if (viewInfo) {
    const cachedViewInfo = _.omit(viewInfo, "appTitle", "grainIcon");
    Grains.update(grainId, { $set: { cachedViewInfo: cachedViewInfo } });
  }

  const permissionsResult = SandstormPermissions.grainPermissions(
      globalDb, vertex, viewInfo || {}, observer.invalidate.bind(observer));

  if (permissionsResult.observeHandle) {
    observer.whenRevoked(permissionsResult.observeHandle.stop
        .bind(permissionsResult.observeHandle))
  }

  if (!permissionsResult.permissions) {
    throw new Meteor.Error("access-denied", "access denied");
  }

  if (sessionId) {
    Sessions.update({
      _id: sessionId,
    }, {
      $set: {
        viewInfo: viewInfo || {},
        permissions: permissionsResult.permissions,
      },
    });
  }

  userInfo.permissions = permissionsResult.permissions;
  userInfo.deprecatedPermissionsBlob = boolListToBuffer(permissionsResult.permissions);

  return { uiView, userInfo };
}

class GatewayRouterImpl {
  openUiSession(sessionId, params) {
    const observer = new PermissionsObserver();
    return inMeteor(() => {
      // We need to know both when this session appears and when it disappears.
      const session = new Promise((resolve, reject) => {
        const sessionObserver = Sessions.find({ _id: sessionId }).observe({
          added(session) {
            resolve(session);
          },
          removed() {
            observer.invalidate();
          }
        });
        observer.whenRevoked(() => sessionObserver.stop());

        // Due to race conditions, the session may not exist yet when we receive a request to open
        // it. We'll block for a limited time waiting for it.
        //
        // TODO(someday): One problem with this is that after access has been revoked, requests will
        //   hang instead of return an error, because revocation is accomplished by deleting the
        //   session record. Can/should we do better? The UI will remove the iframe on revocation
        //   anyhow, so maybe it's fine.
        const task = Meteor.setTimeout(() => {
          reject(new Error("Requested session that no longer exists, and " +
              "timed out waiting for client to restore it. This can happen if you have " +
              "opened an app's content in a new window and then closed it in the " +
              "UI. If you see this error *inside* the Sandstorm UI, please report a " +
              "bug and describe the circumstances of the error."));
        }, SESSION_PROXY_TIMEOUT);
        observer.whenRevoked(() => Meteor.clearTimeout(task));
      }).await();

      // If the session has no identityId, then it's an incognito session. It may still have a
      // userId, but that should be ignored.
      const actingAccountId = session.identityId ? session.userId : null;

      let vertex;
      if (session.hashedToken) {
        const tokenInfo = ApiTokens.findOne(session.hashedToken);
        validateWebkey(tokenInfo);
        vertex = { token: { _id: session.hashedToken, grainId: session.grainId } };
      } else {
        vertex = { grain: { _id: session.grainId, accountId: actingAccountId } };
      }

      const { uiView, userInfo } = getUiViewAndUserInfo(
          session.grainId, vertex, actingAccountId, session.identityId, sessionId, observer);

      const serializedParams = Capnp.serialize(WebSession.Params, params);

      let rawSession;
      const sessionContext = makeHackSessionContext(
          session.grainId, sessionId, actingAccountId, session.tabId);
      if (session.powerboxRequest) {
        rawSession = uiView.newRequestSession(userInfo, sessionContext,
             WebSession.typeId, serializedParams, session.powerboxRequest.descriptors,
             new Buffer(session.tabId, "hex")).session;
      } else {
        rawSession = uiView.newSession(userInfo, sessionContext,
             WebSession.typeId, serializedParams, new Buffer(session.tabId, "hex")).session;
      }

      let persistent = rawSession.castAs(SystemPersistent);

      // TODO(security): List the user's permissions as a requirement here, in case save()
      //   is called. Currently nothing obtained through a WebSession can be saved anyway, so
      //   this is not relevant.
      let cap = persistent.addRequirements([], observer).cap;

      let hasLoaded = session.hasLoaded;
      let webSession = cap.castAs(WebSession);

      rawSession.close();
      persistent.close();
      cap.close();
      uiView.close();

      if (session.denied) {
        // Apparently access was denied in the past, but this time it succeded, so remove the error
        // message.
        Sessions.update({ _id: sessionId }, { $unset: { denied: "" } });
      }

      return {
        session: webSession,
        loadingIndicator: {
          close() {
            if (!hasLoaded) {
              inMeteor(() => {
                Sessions.update({ _id: sessionId }, { $set: { hasLoaded: true } });
              });
            }
            hasLoaded = true;
          }
        },
        parentOrigin: session.parentOrigin || process.env.ROOT_URL
      };
    }).catch(err => {
      observer.invalidate();
      if ((err instanceof Meteor.Error) && (typeof err.error === "string")) {
        Sessions.update({ _id: sessionId }, { $set: { denied: err.error } });
      } else {
        console.error(err.stack);
      }
      throw err;
    });
  }

  openApiSession(apiToken, params) {
    const observer = new PermissionsObserver();
    return inMeteor(() => {
      const hashedToken = Crypto.createHash("sha256").update(apiToken).digest("base64");
      const tabId = Crypto.createHash("sha256").update("tab:").update(hashedToken)
          .digest("hex").slice(0, 32);

      const tokenInfo = ApiTokens.findOne(hashedToken);
      validateWebkey(tokenInfo);

      if (tokenInfo.expires) {
        const timer = setTimeout(() => observer.invalidate(),
            tokenInfo.expires.getTime() - Date.now());
        observer.whenRevoked(() => clearTimeout(timer));
      }

      const grainId = tokenInfo.grainId;
      const actingAccountId = tokenInfo.forSharing ? null : tokenInfo.accountId;

      const { uiView, userInfo } = getUiViewAndUserInfo(
          grainId, { token: tokenInfo }, actingAccountId, null, null, observer);

      const serializedParams = Capnp.serialize(ApiSession.Params, params);

      let rawSession;
      const sessionContext = makeHackSessionContext(grainId, null, actingAccountId, tabId);
      try {
        rawSession = uiView.newSession(userInfo, sessionContext,
           ApiSession.typeId, serializedParams, new Buffer(tabId, "hex")).await().session;
      } catch (err) {
        // If the app doesn't explicitly support ApiSession, fall back to WebSession for
        // backwards compatibility.
        //
        // TODO(apibump): Move this fallback into the compat layer and remove it from here.
        //
        // TODO(now): The old code filled in WebSession.Params based on the API request. Do we need
        //   to extend ApiSession.Params to include the same info for compat? Try testing all the
        //   apps that matter...
        rawSession = uiView.newSession(userInfo, sessionContext,
             WebSession.typeId, null, new Buffer(tabId, "hex")).session;
      }

      // TODO(security): List the token's validity as a requirement here, in case save()
      //   is called. Currently nothing obtained through a WebSession can be saved anyway, so
      //   this is not relevant.
      let persistent = rawSession.castAs(SystemPersistent);
      let cap = persistent.addRequirements([], observer).cap;
      let session = cap.castAs(ApiSession)

      rawSession.close();
      persistent.close();
      cap.close();
      uiView.close();

      return { session };
    }).catch(err => {
      observer.invalidate();
      if ((err instanceof Meteor.Error) && (typeof err.error === "string")) {
        Sessions.update({ _id: sessionId }, { $set: { denied: err.error } });
      } else {
        console.error(err.stack);
      }
      throw err;
    });
  }

  keepaliveApiToken(apiToken, durationMs) {
    return inMeteor(() => {
      const hashedToken = Crypto.createHash("sha256").update(apiToken).digest("base64");
      const tokenInfo = ApiTokens.findOne(hashedToken);
      validateWebkey(tokenInfo, Date.now() + durationMs);
    });
  }

  getApiHostResource(hostId, path) {
    return inMeteor(() => {
      const host = globalDb.collections.apiHosts.findOne(hostId);
      if (!host) return {}

      const resource = (host.resources || {})[SandstormDb.escapeMongoKey(path)];
      if (!resource) return {}

      if (typeof resource.body === "string") {
        resource.body = new Buffer(resource.body, "utf8");
      }
      return { resource };
    });
  }

  getApiHostOptions(hostId) {
    return inMeteor(() => {
      const host = globalDb.collections.apiHosts.findOne(hostId);
      return (host && host.options) || {};
    });
  }

  subscribeTlsKeys(callback) {
    currentTlsKeysCallback = callback;

    return new Promise((resolve, reject) => {
      inMeteor(() => {
        function setKeys(key, certChain) {
          callback.setKeys(key, certChain).catch(err => {
            if (err.kjType === "disconnected") {
              // Client will reconnect.
              observer.stop();
              if (currentTlsKeysCallback == callback) {
                currentTlsKeysCallback = null;
              }
            } else {
              console.error("registering new TLS keys failed", err);
            }
          });
        }

        let anyAdded = false;

        const observer = globalDb.collections.settings.find({_id: "tlsKeys"})
            .observe({
          added(keys) {
            setKeys(keys.value.key, keys.value.certChain);
            anyAdded = true;
          },

          changed(keys) {
            setKeys(keys.value.key, keys.value.certChain);
          },

          removed() {
            setKeys(null, null);
          },

          // Since we never call resolve() or reject(), V8 will happily garbage-collect all the
          // .then() continuations. But, that will cause the call to prematurely fail out as the
          // C++ PromiseFulfiller for its completion will be destroyed. We can prevent this by
          // creating a false reference to the resolver. Of course, a smarter GC could still
          // collect it... hope that doesn't happen.
          //
          // GC is terrible.
          dontGcMe: resolve
        });

        if (!anyAdded) {
          // Inform gateway that there are no keys.
          setKeys(null, null);
        }
      });
    });
  }

  getStaticPublishingHost(publicId) {
    return inMeteor(() => {
      const grain = Grains.findOne({ publicId: publicId }, { fields: { _id: 1 } });
      if (grain) {
        return globalBackend.useGrain(grain._id, supervisor => {
          return supervisor.keepAlive().then(() => { return { supervisor }; });
        });
      } else {
        throw new Meteor.Error(404, "No such grain for public ID: " + publicId);
      }
    });
  }

  routeForeignHostname(hostname) {
    return inMeteor(() => {
      if (globalDb.hostIsStandalone(hostname)) {
        return { info: { standalone: null, ttlSeconds: DNS_CACHE_TTL_SECONDS } };
      }

      return new Promise((resolve, reject) => {
        Dns.resolveTxt("sandstorm-www." + hostname, (err, records) => {
          if (err) {
            if (err.code == Dns.NOTFOUND || err.code == Dns.NODATA) {
              resolve({ info: { unknown: null } });
            } else {
              reject(err);
            }
          } else if (records.length !== 1) {
            reject(new Error('Host "sandstorm-www.' + hostname +
                '" must have exactly one TXT record.'));
          } else {
            resolve({
              info: { staticPublishing: records[0].join(""), ttlSeconds: DNS_CACHE_TTL_SECONDS }
            });
          }
        });
      });
    });
  }
}

makeGatewayRouter = function () {
  return new Capnp.Capability(new GatewayRouterImpl, GatewayRouter);
}

// =======================================================================================
// Session management from Meteor client

function storeReferralProgramInfoApiTokenCreated(db, accountId, apiTokenAccountId) {
  // From the Referral program's perspective, if Bob's Account has no referredByComplete, then we
  // update Bob's Account to say it's referredBy Alice's Account (which is apiTokenAccountId).
  check(accountId, String);
  check(apiTokenAccountId, String);

  // Bail out early if referrals aren't enabled
  if (!db.isReferralEnabled()) {
    return;
  }

  const aliceAccountId = apiTokenAccountId;
  const bobAccountId = accountId;

  if (Meteor.users.find({
    _id: bobAccountId,
    referredByComplete: { $exists: true },
  }).count() > 0) {
    return;
  }

  // Only actually update Bob's Account ID if there is no referredBy.
  Meteor.users.update(
    { _id: bobAccountId, referredBy: { $exists: false } },
    { $set: { referredBy: aliceAccountId } });
};

function referralProgramLogSharingTokenUse(db, bobAccountId) {
  // Hooray! The sharing token is valid! Someone (let's call them Charlie) is going to get a UiView
  // to this grain!  This means that the user who created this apiToken knows how to use the 'share
  // access' interface. Let's call them Bob.
  //
  // If Bob himself was referred by Alice, then Alice is now eligible for referral credit, as Bob
  // has proven he knows how to share.
  //
  // If Bob's Account.referredByComplete is not yet set, then look at Bob's referredBy -- let's
  // call that Alice.
  //
  // We copy Alice's account ID to Bob's Account.referredByComplete, and then update Alice's
  // referredAccountIds to point at Bob's Account, and then remove the referredBy from Bob's
  // Account since it has become redundant.
  //
  // Implementation note: this does mean that Alice can get referral credit for Bob by sharing a
  // link with Bob, even if Bob already had an account.

  // Bail out early if referrals aren't enabled
  if (!db.isReferralEnabled()) {
    return;
  }

  const bobAccount = Meteor.users.findOne({ _id: bobAccountId });

  // Bail out if Bob is already a complete referral.
  if (bobAccount.referredByComplete) {
    return;
  }

  // Bail out if Bob wasn't referred by anyone.
  if (!bobAccount.referredBy) {
    return;
  }

  const aliceAccountId = bobAccount.referredBy;

  // Store Bob's Account.referralCompletedBy.
  const now = new Date();
  Meteor.users.update({
    _id: bobAccountId,
    referredBy: { $exists: true },
    referredByComplete: { $exists: false },
  }, {
    $rename: {
      referredBy: "referredByComplete",
    },
    $set: {
      referredCompleteDate: now,
    },
  });

  // Update Alice's Account.referredAccountIds.
  Meteor.users.update({ _id: aliceAccountId }, {
    $push: { referredAccountIds: bobAccountId },
  });
}

function parsePowerboxDescriptorList(list) {
  return list.map(packedDescriptor =>
      Capnp.parse(Powerbox.PowerboxDescriptor, new Buffer(packedDescriptor, "base64"),
                  { packed: true }));
}

const Hex256 = Match.Where(function(str){
  check(str, String);
  return /^[0-9a-f]{64}$/.test(str);
});

function getSharersTitle(db, grain, tokenInfo) {
  if (grain && grain.userId === tokenInfo.accountId) {
    return grain.title;
  } else {
    const sharerToken = tokenInfo.accountId &&
        db.collections.apiTokens.findOne({
          grainId: tokenInfo.grainId,
          "owner.user.accountId": tokenInfo.accountId,
        }, {
          sort: {
            lastUsed: -1,
          },
        });
    if (sharerToken) {
      return sharerToken.owner.user.title;
    } else {
      return "shared grain";
    }
  }
}

function createSession(db, userId, sessionId, options) {
  let grainId = options.grainId;
  let token = options.token;

  if (!grainId && !token) {
    throw new Meteor.Error(400, "must specify grainId or token");
  }
  if (grainId && token) {
    throw new Meteor.Error(400, "must specify only one of grainId or token");
  }

  const session = {
    _id: sessionId,
    grainId: grainId,
    hostId: Crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 32),
    tabId: Crypto.createHash("sha256").update("tab:").update(sessionId).digest("hex").slice(0, 32),
    timestamp: new Date().getTime(),
    hasLoaded: false,
  };

  if (options.parentOrigin) {
    session.parentOrigin = options.parentOrigin;
  }

  let grain = null;
  if (token) {
    session.hashedToken = Crypto.createHash("sha256").update(token).digest("base64");

    const tokenInfo = db.collections.apiTokens.findOne(session.hashedToken);
    if (!tokenInfo) {
      throw new Meteor.Error(404, "no such token");
    }

    session.grainId = grainId = tokenInfo.grainId;
    grain = Grains.findOne(grainId);

    session.sharersTitle = getSharersTitle(db, grain, tokenInfo);

    // Apply referral program.
    if (tokenInfo.accountId) {
      referralProgramLogSharingTokenUse(db, tokenInfo.accountId);
    }
  }

  if (userId) {
    // TODO(cleanup): Can we stop setting userId on the session if we're not revealing identity?
    session.userId = userId;
    if (options.revealIdentity) {
      grain = grain || Grains.findOne(grainId);
      if (grain) {
        session.identityId = db.getOrGenerateIdentityId(userId, grain);
      } else {
        // The session will error out later.
      }
    }
  }

  // TODO(now): We need to make sure the session is refreshed when the grain is upgraded.

  if (options.powerboxRequest) {
    session.powerboxRequest = {
      descriptors: parsePowerboxDescriptorList(options.powerboxRequest.descriptors),
      requestingSession: options.powerboxRequest.requestingSession,
    };
  }

  Sessions.insert(session);

  return session;
}

// Kill off sessions idle for >~3 minutes.
const TIMEOUT_MS = 180000;
SandstormDb.periodicCleanup(TIMEOUT_MS, () => {
  const now = new Date().getTime();
  Sessions.remove({ timestamp: { $lt: (now - TIMEOUT_MS) } });
});

function bumpSession(sessionId) {
  const session = Sessions.findOne(sessionId);
  if (session) {
    globalDb.collections.sessions.update({ _id: sessionId },
        { $set: { timestamp: new Date().getTime() } });
    globalBackend.updateLastActive(session.grainId, session.userId);
  }
}

Meteor.publish("sessions", function (sessionId, options) {
  // This subscription not only subscribes to the session record, but also creates the session if
  // necessary using the parameters.
  //
  // TODO(cleanup): Stop storing sessions to Mongo at all; they can be kept in-memory. But we need
  //   to get load balancing right in Blackrock so that UI session hosts use the same shell replica
  //   as created them. That shouldn't be too hard.
  // TODO(security): The session ID is a sensitive secret, since anyone having the ID can make HTTP
  //   requests to the session. Stop storing the ID and instead store only its hash.

  check(sessionId, Hex256);
  check(options, Match.Optional({
    grainId: Match.Optional(String),
    token: Match.Optional(String),

    powerboxRequest: Match.Optional({
      descriptors: [String],
      requestingSession: String,
    }),

    revealIdentity: Match.Optional(Boolean),
    // Note: You can hide identity when opening a grain by grain ID (no token) in the old sharing
    //   model. Conversely, you can reveal identity without redeeming a sharing token with
    //   standalone grains.

    parentOrigin: Match.Optional(String)
  }));

  const db = this.connection.sandstormDb;

  // We exclude powerboxRequest because the client already has the descriptor list in packed
  // format, and the parsed format can be kind of large.
  const query = db.collections.sessions.find({ _id: sessionId },
      { fields: { powerboxRequest: 0 } });

  if (query.count() == 0) {
    if (options) {
      // This subscription is intended to create the session.
      createSession(db, this.userId, sessionId, options);
    }
  } else {
    bumpSession(sessionId);
  }

  // While subscription is active, continuously keep the session alive.
  const keepaliveInterval = Meteor.setInterval(() => bumpSession(sessionId), 60000);

  this.onStop(() => {
    Meteor.clearInterval(keepaliveInterval);
  });

  return query;
});

Meteor.methods({
  redeemSharingToken(token) {
    check(token, String);

    const db = this.connection.sandstormDb;
    const hashedToken = Crypto.createHash("sha256").update(token).digest("base64");

    if (!this.userId) throw new Meteor.Error(403, "must be logged in");

    const apiToken = db.collections.apiTokens.findOne(hashedToken);
    if (!apiToken) throw new Meteor.Error(404, "no such token");

    const grain = db.collections.grains.findOne(apiToken.grainId);
    if (!grain) throw new Meteor.Error(404, "no such grain");

    if (this.userId != apiToken.accountId && this.userId != grain.userId &&
        !db.collections.apiTokens.findOne(
            { "owner.user.accountId": this.userId, parentToken: hashedToken })) {
      const title = getSharersTitle(db, grain, apiToken);
      const owner = { user: { accountId: this.userId, title: title } };

      // Create a new API token for the account redeeming this token.
      const result = SandstormPermissions.createNewApiToken(
          db, { rawParentToken: token }, apiToken.grainId,
          apiToken.petname || "redeemed webkey",
          { allAccess: null }, owner);
      globalDb.addContact(apiToken.accountId, this.userId);

      // If the parent API token is forSharing and it has an accountId, then the logged-in user (call
      // them Bob) is about to access a grain owned by someone (call them Alice) and save a reference
      // to it as a new ApiToken. (For share-by-link, this occurs when viewing the grain. For
      // share-by-identity, this happens immediately.)
      if (result.parentApiToken) {
        const parentApiToken = result.parentApiToken;
        if (parentApiToken.forSharing && parentApiToken.accountId) {
          storeReferralProgramInfoApiTokenCreated(
              db, this.userId, parentApiToken.accountId);
        }
      }
    }

    return { grainId: grain._id };
  }
});

// =======================================================================================
// Backwards-compatibility with clients started before proxy.js was deleted. This is only needed to
// cover one update; once all clients click to refresh, we can delete this.
//
// TODO(cleanup): Delete in next version.

function generateSessionId(grainId, userId, packageSalt, clientSalt) {
  const sessionParts = [grainId, clientSalt];
  if (userId) {
    sessionParts.push(userId);
  }

  if (packageSalt) {
    sessionParts.push(packageSalt);
  }

  const sessionInput = sessionParts.join(":");
  return Crypto.createHash("sha256").update(sessionInput).digest("hex");
}

Meteor.methods({
  openSession(grainId, revealIdentity, cachedSalt, options) {
    check(grainId, String);
    check(cachedSalt, Match.OneOf(undefined, null, String));
    options = options || {};
    check(options, {
      powerboxRequest: Match.Optional({
        descriptors: [String],
        requestingSession: String,
      }),
    });
    options.revealIdentity = !!revealIdentity;
    options.grainId = grainId;

    cachedSalt = cachedSalt || Random.id(22);
    const grain = Grains.findOne(grainId);
    const packageSalt = grain && grain.packageSalt;
    const sessionId = generateSessionId(grainId, this.userId, packageSalt, cachedSalt);

    let session = Sessions.findOne(sessionId);
    if (!session) {
      session = createSession(globalDb, this.userId, sessionId, options);
    }

    return {
      sessionId: session._id,
      title: null,
      grainId: grainId,
      hostId: session.hostId,
      tabId: session.tabId,
      salt: cachedSalt,
    };
  },

  openSessionFromApiToken(params, revealIdentity, cachedSalt, neverRedeem, parentOrigin, options) {
    neverRedeem = neverRedeem || false;
    parentOrigin = parentOrigin || process.env.ROOT_URL;
    options = options || {};

    check(params, {
      token: String,
      incognito: Match.Optional(Boolean),  // obsolete, ignored
    });
    revealIdentity = !!revealIdentity;
    check(cachedSalt, Match.OneOf(undefined, null, String));
    check(neverRedeem, Boolean);
    check(parentOrigin, String);
    check(options, {
      powerboxRequest: Match.Optional({
        descriptors: [String],
        requestingSession: String,
      }),
    });
    options.revealIdentity = !!revealIdentity;
    options.token = params.token;
    if (parentOrigin) options.parentOrigin = parentOrigin;

    const token = params.token;

    if (this.userId && revealIdentity && !neverRedeem) {
      const grainId = Meteor.call("redeemSharingToken", token).grainId;
      return { redirectToGrain: grainId };
    }

    const hashedToken = Crypto.createHash("sha256").update(token).digest("base64");
    const apiToken = ApiTokens.findOne(hashedToken);
    if (!apiToken) throw new Error("no such token");

    cachedSalt = cachedSalt || Random.id(22);
    const grainId = apiToken.grainId;
    const grain = Grains.findOne(grainId);
    const packageSalt = grain && grain.packageSalt;
    const sessionId = generateSessionId(grainId, this.userId, packageSalt, cachedSalt);

    let session = Sessions.findOne(sessionId);
    if (!session) {
      session = createSession(globalDb, this.userId, sessionId, options);
    }

    return {
      sessionId: session._id,
      title: session.sharersTitle,
      grainId: grainId,
      hostId: session.hostId,
      tabId: session.tabId,
      salt: cachedSalt,
    };
  },

  keepSessionAlive(sessionId) {
    check(sessionId, String);

    // If the session is gone, let the client know they need to call openSession() again.
    // (We don't need to bumpSession() from here because we now do that in the session
    // subscription.)
    return Sessions.find({ _id: sessionId }).count() > 0;
  }
});
