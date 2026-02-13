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

import { inMeteor } from "/imports/server/async-helpers";
import Crypto from "crypto";
import Dns from "dns";

import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import { _ } from "meteor/underscore";
import { Random } from "meteor/random";

import Capnp from "/imports/server/capnp";
import { SandstormDb } from "/imports/sandstorm-db/db";
import { globalDb } from "/imports/db-deprecated";
import { SandstormPermissions } from "/imports/sandstorm-permissions/permissions";

import { responseCodes } from "/imports/server/web-session";
import { makeHackSessionContext } from "/imports/server/hack-session";

const GatewayRouter = Capnp.importSystem("sandstorm/backend.capnp").GatewayRouter;
const ApiSession = Capnp.importSystem("sandstorm/api-session.capnp").ApiSession;
const WebSession = Capnp.importSystem("sandstorm/web-session.capnp").WebSession;
const SystemPersistent = Capnp.importSystem("sandstorm/supervisor.capnp").SystemPersistent;
const Powerbox = Capnp.importSystem("sandstorm/powerbox.capnp");

const SESSION_PROXY_TIMEOUT = 60000;
const DNS_CACHE_TTL_SECONDS = 30;

globalThis.currentTlsKeysCallback = null;

// If this is Blackrock and we started up within one hour of a scheduled maintenance, we want to
// stagger startup of grains in order to give the back-end time to warm up.
const processStartTime = Date.now();
let useStagedStartup = false;

const WARMUP_TIME = 600000;    // 10 minutes
const WARMUP_MULTIPLE = 1024;  // Start out accepting 1/1024 of requests, warm exponentially
const WARMUP_RATE = Math.log(WARMUP_MULTIPLE) / WARMUP_TIME;

if ("replicaNumber" in Meteor.settings) {  // is Blackrock?
  globalDb.getSettingAsync("adminAlertTime").then((maintenanceTime) => {
    useStagedStartup =
        !!maintenanceTime &&
        maintenanceTime.getTime() <= processStartTime &&
        maintenanceTime.getTime() + 3600000 > processStartTime;

    if (useStagedStartup) {
      console.log("*** starting up during maintenance window; applying slow warm-up");

      // Automatically clear maintenance message after warmup time.
      Meteor.setTimeout(() => {
        console.log("*** warm-up complete");
        globalDb.collections.settings.upsertAsync({ _id: "adminAlertTime" }, { value: null })
          .catch((err) => {
            console.error("Failed clearing adminAlertTime after warmup:", err);
          });
      }, WARMUP_TIME);
    }
  }).catch((err) => {
    console.error("Failed to load adminAlertTime for staged startup:", err);
  });
}

async function awaitRateLimit(type, hexId, userId) {
  if (!useStagedStartup) return;
  let now = Date.now() - processStartTime;
  if (now > 256000 || now < 0) return;

  if (userId && ((await Meteor.users.findOneAsync(userId)) || {}).isAdmin) return;

  // Calculate fraction at which this grain should start.
  let threshold = parseInt(hexId.slice(-4), 16) % WARMUP_MULTIPLE;

  // Find time when e^rt > threshold
  let startTime = Math.floor(Math.log(threshold) / WARMUP_RATE);

  let waitTime = startTime - now;
  if (!waitTime || waitTime < 0) return;

  console.log(`${type} ${hexId}: warmup wait ${waitTime} ms`);
  await new Promise(resolve => setTimeout(resolve, waitTime));
  console.log(`${type} ${hexId}: warmup wait done`);
}

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
}

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

async function validateWebkey(apiToken, refreshedExpiration) {
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
      await globalDb.collections.apiTokens.updateAsync(
          apiToken._id, { $set: { expiresIfUnused: refreshedExpiration } });
    } else {
      // It's getting used now, so clear the expiresIfUnused field.
      await globalDb.collections.apiTokens.updateAsync(
          apiToken._id, { $set: { expiresIfUnused: null } });
    }
  }

  if (apiToken.objectId || apiToken.frontendRef) {
    throw new Meteor.Error(403, "ApiToken refers to a non-webview Capability.");
  }
}

async function getUiViewAndUserInfo(grainId, vertex, accountId, identityId, sessionId, observer) {
  if (!accountId && await globalDb.getOrganizationDisallowGuestsAsync()) {
    throw new Meteor.Error("no-guests", "server doesn't allow guest access");
  }
  // TODO(now): Observe the "no-guests" policy and revoke if it is turned on.

  const grain = await globalDb.collections.grains.findOneAsync(grainId);
  if (!grain) {
    throw new Meteor.Error("no-such-grain", "grain has been deleted");
  } else if (grain.trashed) {
    throw new Meteor.Error("grain-is-in-trash", "grain is in trash");
  } else if (grain.suspended) {
    throw new Meteor.Error("grain-owner-suspended", "grain owner has been suspended");
  }
  // TODO(now): Observe the grain lookup to see if it becomes trashed or suspended, or if it
  //   switches from old to new sharing model.

  let pkg = await globalDb.collections.packages.findOneAsync(grain.packageId);
  if (!pkg || pkg.status !== "ready") {
    let devapp = await globalDb.collections.devPackages.findOneAsync({appId: grain.appId});
    if (!devapp) {
      let err = new Meteor.Error("missing-package", "grain's package is not installed");
      err.missingPackageId = grain.packageId;
      throw err;
    }
  }

  const isOwnerVertex = !!(vertex.grain && accountId && accountId === grain.userId);

  let userInfo = null;
  if (accountId) {
    // If accountId is non-null, we're revealing identity. But if we didn't compute the identity ID
    // yet, we need to do that now.
    identityId = identityId || await globalDb.getOrGenerateIdentityIdAsync(accountId, grain);

    const user = await Meteor.users.findOneAsync({ _id: accountId });
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
      identity: globalThis.makeIdentity(user._id, [idCapRequirement]),
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
  if (!isOwnerVertex && !(await SandstormPermissions.mayOpenGrainAsync(globalDb, vertex))) {
    throw new Meteor.Error("access-denied", "access denied");
  }

  let uiView;
  const viewInfo = await globalThis.globalBackend.useGrain(grainId, supervisor => {
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
  });

  if (viewInfo) {
    const cachedViewInfo = _.omit(viewInfo, "appTitle", "grainIcon");
    await globalDb.collections.grains.updateAsync(grainId, { $set: { cachedViewInfo: cachedViewInfo } });
  }

  let permissionsResult;
  if (isOwnerVertex) {
    const permissionCount = ((viewInfo || {}).permissions || []).length;
    permissionsResult = {
      permissions: new Array(permissionCount).fill(true),
      observeHandle: null,
    };
  } else {
    permissionsResult = await SandstormPermissions.grainPermissionsAsync(
        globalDb, vertex, viewInfo || {}, observer.invalidate.bind(observer));
  }

  if (permissionsResult.observeHandle) {
    observer.whenRevoked(() => {
      Promise.resolve(permissionsResult.observeHandle).then((h) => {
        if (typeof h === "function") { h(); } else if (h && typeof h.stop === "function") h.stop();
      }).catch((err) => {
        console.error("Failed to stop grain permissions observer:", err);
      });
    });
  }

  if (!permissionsResult.permissions) {
    throw new Meteor.Error("access-denied", "access denied");
  }

  globalThis.globalBackend.updateLastActive(grainId, accountId).catch((err) => {
    console.error("Failed updating lastActive for grain session:", err);
  });

  if (sessionId) {
    await globalDb.collections.sessions.updateAsync({
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
    return inMeteor(async () => {
      // We need to know both when this session appears and when it disappears.
      const session = await new Promise((resolve, reject) => {
        let sessionObserver = null;
        const stopSessionObserver = () => {
          Promise.resolve(sessionObserver).then((h) => {
            if (typeof h === "function") { h(); } else if (h && typeof h.stop === "function") h.stop();
          }).catch((err) => {
            console.error("Failed to stop session observer on revocation:", err);
          });
        };
        globalDb.collections.sessions.find({ _id: sessionId }).observeAsync({
          added(session) {
            resolve(session);
          },
          removed() {
            observer.invalidate();
          }
        }).then((h) => {
          sessionObserver = h;
        }).catch((err) => {
          reject(err);
        });
        observer.whenRevoked(() => {
          stopSessionObserver();
        });

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
      });

      await awaitRateLimit("UI", sessionId, session.userId);

      // If the session has no identityId, then it's an incognito session. It may still have a
      // userId, but that should be ignored.
      const actingAccountId = session.identityId ? session.userId : null;

      let vertex;
      if (session.hashedToken) {
        const tokenInfo = await globalDb.collections.apiTokens.findOneAsync(session.hashedToken);
        await validateWebkey(tokenInfo);
        vertex = { token: { _id: session.hashedToken, grainId: session.grainId } };
      } else {
        vertex = { grain: { _id: session.grainId, accountId: actingAccountId } };
      }

      const { uiView, userInfo } = await getUiViewAndUserInfo(
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
        await globalDb.collections.sessions.updateAsync({ _id: sessionId }, { $unset: { denied: "" } });
      }

      return {
        session: webSession,
        loadingIndicator: {
          close() {
            if (!hasLoaded) {
              inMeteor(async () => {
                await globalDb.collections.sessions.updateAsync(
                    { _id: sessionId }, { $set: { hasLoaded: true } });
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
        let fields = { denied: err.error };
        if (err.missingPackageId) {
          fields.missingPackageId = err.missingPackageId;
        }
        globalDb.collections.sessions.updateAsync({ _id: sessionId }, { $set: fields }).catch((updateErr) => {
          console.error("Failed updating denied session state:", updateErr);
        });
        return {
          session: makeErrorSession(err),
          loadingIndicator: { close() {} },
          parentOrigin: process.env.ROOT_URL,
        };
      } else {
        globalDb.collections.sessions.updateAsync(
            { _id: sessionId }, { $set: { hasLoaded: true } }).catch((updateErr) => {
          console.error("Failed updating hasLoaded session state:", updateErr);
        });
        console.error(err.stack);
      }
      throw err;
    });
  }

  openApiSession(apiToken, params) {
    const observer = new PermissionsObserver();
    return inMeteor(async () => {
      const hashedToken = Crypto.createHash("sha256").update(apiToken).digest("base64");
      const tabId = Crypto.createHash("sha256").update("tab:").update(hashedToken)
          .digest("hex").slice(0, 32);

      const tokenInfo = await globalDb.collections.apiTokens.findOneAsync(hashedToken);
      await validateWebkey(tokenInfo);

      if (tokenInfo.expires) {
        const timer = setTimeout(() => observer.invalidate(),
            tokenInfo.expires.getTime() - Date.now());
        observer.whenRevoked(() => clearTimeout(timer));
      }

      await awaitRateLimit("API", tabId, !tokenInfo.forSharing && tokenInfo.accountId);

      const grainId = tokenInfo.grainId;
      const actingAccountId = tokenInfo.forSharing ? null : tokenInfo.accountId;

      const { uiView, userInfo } = await getUiViewAndUserInfo(
          grainId, { token: tokenInfo }, actingAccountId, null, null, observer);

      const serializedParams = Capnp.serialize(ApiSession.Params, params);

      let rawSession;
      const sessionContext = makeHackSessionContext(grainId, null, actingAccountId, tabId);
      try {
        rawSession = (await uiView.newSession(userInfo, sessionContext,
           ApiSession.typeId, serializedParams, new Buffer(tabId, "hex"))).session;
      } catch (err) {
        // If the app doesn't explicitly support ApiSession, fall back to WebSession for
        // backwards compatibility. Some really old apps require a parseable basePath, so we supply
        // them with a fake one.
        //
        // TODO(apibump): Move this fallback into the compat layer and remove it from here.
        const serializedWebParams = Capnp.serialize(WebSession.Params, {
          basePath: "https://sandbox"
        });
        rawSession = (await uiView.newSession(userInfo, sessionContext,
             WebSession.typeId, serializedWebParams, new Buffer(tabId, "hex"))).session;
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
      if (err instanceof Meteor.Error) {
        return { session: makeErrorSession(err) };
      } else {
        console.error(err.stack);
      }
      throw err;
    });
  }

  keepaliveApiToken(apiToken, durationMs) {
    return inMeteor(async () => {
      const hashedToken = Crypto.createHash("sha256").update(apiToken).digest("base64");
      const tokenInfo = await globalDb.collections.apiTokens.findOneAsync(hashedToken);
      await validateWebkey(tokenInfo, new Date(Date.now() + durationMs));
    });
  }

  getApiHostResource(hostId, path) {
    return inMeteor(async () => {
      const host = await globalDb.collections.apiHosts.findOneAsync(hostId);
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
    return inMeteor(async () => {
      const host = await globalDb.collections.apiHosts.findOneAsync(hostId);
      return (host && host.options) || {};
    });
  }

  subscribeTlsKeys(callback) {
    globalThis.currentTlsKeysCallback = callback;

    return new Promise((resolve, reject) => {
      inMeteor(() => {
        function setKeys(key, certChain) {
          callback.setKeys(key, certChain).catch(err => {
            if (err.kjType === "disconnected") {
              // Client will reconnect.
              Promise.resolve(observer).then((h) => {
                if (typeof h === "function") { h(); } else if (h && typeof h.stop === "function") h.stop();
              }).catch((stopErr) => {
                console.error("Failed to stop TLS keys observer:", stopErr);
              });
              if (globalThis.currentTlsKeysCallback == callback) {
                globalThis.currentTlsKeysCallback = null;
              }
            } else {
              console.error("registering new TLS keys failed", err);
            }
          });
        }

        let anyAdded = false;

        let observer = null;
        globalDb.collections.settings.find({_id: "tlsKeys"})
            .observeAsync({
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
        }).then((h) => {
          observer = h;
          if (!anyAdded) {
            // Inform gateway that there are no keys.
            setKeys(null, null);
          }
        }).catch((err) => {
          console.error("Failed to observe tlsKeys for gateway callback registration:", err);
        });
      });
    });
  }

  getStaticPublishingHost(publicId) {
    return inMeteor(async () => {
      const grain = await globalDb.collections.grains.findOneAsync(
          { publicId: publicId }, { fields: { _id: 1 } });
      if (grain) {
        await awaitRateLimit("WWW", publicId, grain.userId);
        return globalThis.globalBackend.useGrain(grain._id, supervisor => {
          return supervisor.keepAlive().then(() => { return { supervisor }; });
        });
      } else {
        throw new Meteor.Error(404, "No such grain for public ID: " + publicId);
      }
    });
  }

  routeForeignHostname(hostname) {
    return inMeteor(async () => {
      const standaloneDomain = await globalDb.collections.standaloneDomains.findOneAsync({ _id: hostname });
      if (standaloneDomain) {
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

export function makeGatewayRouter() {
  return new Capnp.Capability(new GatewayRouterImpl, GatewayRouter);
}

function makeErrorSession(err) {
  // Return an implementation of WebSession/ApiSession that always returns
  // the specified error. `err` should be a Meteor.Error. Its `error` field
  // can either a numeric error code >= 400, or a string message code. If
  // the latter is unrecognized, a 500 error is returned.

  let code;
  if(typeof(err.error) === "number") {
    code = err.error;
  } else if(typeof(err.error) === "string") {
    const knownCodes = {
      "no-guests": 403,
      "no-such-grain": 401,
      "grain-is-in-trash": 410,
      "grain-owner-suspended": 410,
      "missing-package": 500,
      "access-denied": 403,
    }
    code = knownCodes[err.error]
    if(code === undefined) {
      code = 500;
    }
  }


  const responseCodeInfo = responseCodes[code];
  let response;
  if(responseCodeInfo !== undefined && responseCodeInfo.type === "clientError") {
    response = {
      clientError: {
        statusCode: responseCodeInfo.clientErrorCode
      }
    }
    if("reason" in err) {
      response.clientError.descriptionHtml = err.reason;
    }
  } else {
    response = {
      serverError: {
        descriptionHtml: ("reason" in err)? err.reason : "Internal Server Error"
      }
    }
  }

  return {
    get() { return response },
    post() { return response },
    put() { return response },
    delete() { return response },
    patch() { return response },
    propfind() { return response },
    proppatch() { return response },
    mkcol() { return response },
    copy() { return response },
    move() { return response },
    lock() { return response },
    unlock() { return response },
    acl() { return response },
    report() { return response },
  }
}

// =======================================================================================
// Session management from Meteor client

async function storeReferralProgramInfoApiTokenCreated(db, accountId, apiTokenAccountId) {
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

  if (await Meteor.users.find({
    _id: bobAccountId,
    referredByComplete: { $exists: true },
  }).countAsync() > 0) {
    return;
  }

  // Only actually update Bob's Account ID if there is no referredBy.
  await Meteor.users.updateAsync(
    { _id: bobAccountId, referredBy: { $exists: false } },
    { $set: { referredBy: aliceAccountId } });
}

async function referralProgramLogSharingTokenUse(db, bobAccountId) {
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

  const bobAccount = await Meteor.users.findOneAsync({ _id: bobAccountId });

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
  await Meteor.users.updateAsync({
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
  await Meteor.users.updateAsync({ _id: aliceAccountId }, {
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

async function getSharersTitle(db, grain, tokenInfo) {
  if (grain && grain.userId === tokenInfo.accountId) {
    return grain.title;
  } else {
    const sharerToken = tokenInfo.accountId &&
        await db.collections.apiTokens.findOneAsync({
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

async function resolveSessionAccountUserId(userId) {
  if (!userId) return null;

  // Prefer linked account rows even for legacy users with missing/ambiguous `type`.
  const linkedAccount = await Meteor.users.findOneAsync({
    type: "account",
    $or: [
      { "loginCredentials.id": userId },
      { "nonloginCredentials.id": userId },
    ],
  }, { fields: { _id: 1 } });
  if (linkedAccount) return linkedAccount._id;

  const user = await Meteor.users.findOneAsync({ _id: userId }, { fields: { type: 1 } });
  if (!user) return userId;
  if (user.type === "account") return userId;

  // When logged in as a credential, session permissions should still be evaluated
  // against the owning account.
  const account = await Meteor.users.findOneAsync(
      { type: "account", "loginCredentials.id": userId }, { fields: { _id: 1 } });
  return (account && account._id) || userId;
}

async function createSession(db, userId, sessionId, options) {
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

    const tokenInfo = await db.collections.apiTokens.findOneAsync(session.hashedToken);
    if (!tokenInfo) {
      throw new Meteor.Error(404, "no such token");
    }

    session.grainId = grainId = tokenInfo.grainId;
    grain = await globalDb.collections.grains.findOneAsync(grainId);

    session.sharersTitle = await getSharersTitle(db, grain, tokenInfo);

    // Apply referral program.
    if (tokenInfo.accountId) {
      await referralProgramLogSharingTokenUse(db, tokenInfo.accountId);
    }
  }

  if (userId) {
    const accountUserId = await resolveSessionAccountUserId(userId);
    // TODO(cleanup): Can we stop setting userId on the session if we're not revealing identity?
    session.userId = accountUserId;
    if (options.revealIdentity) {
      grain = grain || await globalDb.collections.grains.findOneAsync(grainId);
      if (grain) {
        session.identityId = await db.getOrGenerateIdentityIdAsync(accountUserId, grain);
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

  await globalDb.collections.sessions.insertAsync(session);
  return session;
}

// Kill off sessions idle for >~3 minutes.
const TIMEOUT_MS = 180000;
SandstormDb.periodicCleanup(TIMEOUT_MS, () => {
  const now = new Date().getTime();
  globalDb.collections.sessions.removeAsync({ timestamp: { $lt: (now - TIMEOUT_MS) } })
    .catch((err) => {
      console.error("Failed to cleanup expired sessions:", err);
    });
});

async function bumpSession(sessionId) {
  const session = await globalDb.collections.sessions.findOneAsync(sessionId);
  if (session) {
    await globalDb.collections.sessions.updateAsync({ _id: sessionId },
        { $set: { timestamp: new Date().getTime() } });
    globalThis.globalBackend.updateLastActive(session.grainId, session.userId).catch((err) => {
      console.error("Failed updating last active in bumpSession:", err);
    });
  }
}

async function maybeUpgradeSessionIdentity(db, sessionId, currentUserId, options) {
  if (!currentUserId || !options || !options.revealIdentity) return;
  const accountUserId = await resolveSessionAccountUserId(currentUserId);

  const session = await globalDb.collections.sessions.findOneAsync(sessionId);
  if (!session) return;

  // Sessions can be created before login state settles; if revealIdentity is requested,
  // keep the persisted session aligned with the current account user.
  if (session.userId === accountUserId && session.identityId) return;

  const grain = await globalDb.collections.grains.findOneAsync(session.grainId);
  if (!grain) return;

  const identityId = await db.getOrGenerateIdentityIdAsync(accountUserId, grain);
  await globalDb.collections.sessions.updateAsync(
      { _id: sessionId },
      { $set: { userId: accountUserId, identityId } });
}

Meteor.publish("sessions", async function (sessionId, options) {
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

  if (await query.countAsync() == 0) {
    if (options) {
      // This subscription is intended to create the session.
      try {
        await createSession(db, this.userId, sessionId, options);
      } catch (err) {
        this.added("sessions", sessionId, {
          denied: (err instanceof Meteor.Error) ? err.error : "internal-error"
        });
      }
    }
  } else {
    maybeUpgradeSessionIdentity(db, sessionId, this.userId, options).catch((err) => {
      console.error("Failed to upgrade session identity:", err);
    });
    bumpSession(sessionId).catch((err) => {
      console.error("Failed to bump session:", err);
    });
  }

  // While subscription is active, continuously keep the session alive.
  const keepaliveInterval = Meteor.setInterval(() => {
    bumpSession(sessionId).catch((err) => {
      console.error("Failed to keep session alive:", err);
    });
  }, 60000);

  this.onStop(() => {
    Meteor.clearInterval(keepaliveInterval);
  });

  return query;
});

Meteor.methods({
  async redeemSharingToken(token) {
    check(token, String);

    const db = this.connection.sandstormDb;
    const hashedToken = Crypto.createHash("sha256").update(token).digest("base64");

    if (!this.userId) throw new Meteor.Error(403, "must be logged in");
    const accountUserId = await resolveSessionAccountUserId(this.userId);

    const apiToken = await db.collections.apiTokens.findOneAsync(hashedToken);
    if (!apiToken) throw new Meteor.Error(404, "no such token");

    const grain = await db.collections.grains.findOneAsync(apiToken.grainId);
    if (!grain) throw new Meteor.Error(404, "no such grain");

    if (accountUserId != apiToken.accountId && accountUserId != grain.userId &&
        !await db.collections.apiTokens.findOneAsync(
            { "owner.user.accountId": accountUserId, parentToken: hashedToken })) {
      const title = await getSharersTitle(db, grain, apiToken);
      const owner = { user: { accountId: accountUserId, title: title } };

      // Create a new API token for the account redeeming this token.
      const result = await SandstormPermissions.createNewApiToken(
          db, { rawParentToken: token }, apiToken.grainId,
          apiToken.petname || "redeemed webkey",
          { allAccess: null }, owner);
      await globalDb.addContact(apiToken.accountId, accountUserId);

      // If the parent API token is forSharing and it has an accountId, then the logged-in user (call
      // them Bob) is about to access a grain owned by someone (call them Alice) and save a reference
      // to it as a new ApiToken. (For share-by-link, this occurs when viewing the grain. For
      // share-by-identity, this happens immediately.)
      if (result.parentApiToken) {
        const parentApiToken = result.parentApiToken;
        if (parentApiToken.forSharing && parentApiToken.accountId) {
          storeReferralProgramInfoApiTokenCreated(
              db, accountUserId, parentApiToken.accountId).catch((err) => {
            console.error("Failed storing referral info for sharing token:", err);
          });
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
  async openSession(grainId, revealIdentity, cachedSalt, options) {
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
    const grain = await globalDb.collections.grains.findOneAsync(grainId);
    const packageSalt = grain && grain.packageSalt;
    const sessionUserId = await resolveSessionAccountUserId(this.userId);
    const sessionId = generateSessionId(grainId, sessionUserId, packageSalt, cachedSalt);

    let session = await globalDb.collections.sessions.findOneAsync(sessionId);
    if (!session) {
      session = await createSession(globalDb, sessionUserId, sessionId, options);
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

  async openSessionFromApiToken(params, revealIdentity, cachedSalt, neverRedeem, parentOrigin, options) {
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
      const grainId = (await Meteor.callAsync("redeemSharingToken", token)).grainId;
      return { redirectToGrain: grainId };
    }

    const hashedToken = Crypto.createHash("sha256").update(token).digest("base64");
    const apiToken = await globalDb.collections.apiTokens.findOneAsync(hashedToken);
    if (!apiToken) throw new Error("no such token");

    cachedSalt = cachedSalt || Random.id(22);
    const grainId = apiToken.grainId;
    const grain = await globalDb.collections.grains.findOneAsync(grainId);
    const packageSalt = grain && grain.packageSalt;
    const sessionUserId = await resolveSessionAccountUserId(this.userId);
    const sessionId = generateSessionId(grainId, sessionUserId, packageSalt, cachedSalt);

    let session = await globalDb.collections.sessions.findOneAsync(sessionId);
    if (!session) {
      session = await createSession(globalDb, sessionUserId, sessionId, options);
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

  async keepSessionAlive(sessionId) {
    check(sessionId, String);

    // If the session is gone, let the client know they need to call openSession() again.
    // (We don't need to bumpSession() from here because we now do that in the session
    // subscription.)
    return await globalDb.collections.sessions.find({ _id: sessionId }).countAsync() > 0;
  }
});
