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
import { inMeteor, waitPromise } from "/imports/server/async-helpers.js";
const Crypto = Npm.require("crypto");

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

class GatewayRouterImpl {
  openUiSession(sessionCookie, params) {
    return getWebSessionForSessionId(sessionCookie, params);
  }

  openApiSession(apiToken, params) {
    return inMeteor(() => {
      const observer = new PermissionsObserver();
      try {
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
        const grain = Grains.findOne(grainId);
        if (!grain) {
          // Grain was deleted, I guess.
          throw new Error("grain has been deleted");
        }

        let identityId = null;
        let accountId = null;
        let userInfo = null;
        if (tokenInfo.accountId && !tokenInfo.forSharing) {
          accountId = tokenInfo.accountId;
          identityId = globalDb.getOrGenerateIdentityId(tokenInfo.accountId, grain);

          const user = Meteor.users.findOne({ _id: tokenInfo.accountId });
          if (!user) {
            throw new Error("user account deleted");
          }

          SandstormDb.fillInPictureUrl(user);

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

        // TODO(security): A revoked user / token can still trigger grain startup because we need
        //   the ViewInfo to compute permissions. Arguably we colud instead use
        //   `grain.cachedViewInfo` if it's there, but what happens if this is the first load after
        //   an update and the role definitions have changed? We'd potentially have to recompute
        //   permissions using the real ViewInfo after noticing the difference. Alternatively, maybe
        //   we could separate the process of verifying that the token is valid with the process of
        //   deciding what permissions bits it provides?
        let uiView;
        const viewInfo = globalBackend.useGrain(grainId, supervisor => {
          uiView = supervisor.getMainView().view;
          return uiView.getViewInfo();
        }).await();

        const permissionsResult = SandstormPermissions.grainPermissions(
            globalDb, { token: tokenInfo }, viewInfo, observer.invalidate.bind(observer));

        if (permissionsResult.observeHandle) {
          observer.whenRevoked(permissionsResult.observeHandle.stop
              .bind(permissionsResult.observeHandle))
        }

        if (!permissionsResult.permissions) {
          throw new Error("API token has been revoked");
        }

        userInfo.permissions = permissionsResult.permissions;
        userInfo.deprecatedPermissionsBlob = boolListToBuffer(permissionsResult.permissions);

        const serializedParams = Capnp.serialize(ApiSession.Params, params);

        let session;
        const sessionContext = makeHackSessionContext(grainId, null, accountId, tabId);
        try {
          session = uiView.newSession(userInfo, sessionContext,
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
          session = uiView.newSession(userInfo, sessionContext,
               WebSession.typeId, null, new Buffer(tabId, "hex")).session;
        }

        // TODO(security): List the user's permissions as a requirement here, in case save()
        //   is called. Currently nothing obtained through a WebSession can be saved anyway, so
        //   this is not relevant.
        session = session.castAs(SystemPersistent).addRequirements([], observer).cap;

        return { session: session.castAs(ApiSession) };
      } catch (err) {
        observer.invalidate();
        throw err;
      }
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
      if (!host) throw new Error("no such API host");

      return host.options || {};
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
}

makeGatewayRouter = function () {
  return new Capnp.Capability(new GatewayRouterImpl, GatewayRouter);
}
