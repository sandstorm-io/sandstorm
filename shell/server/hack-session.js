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

const Crypto = Npm.require("crypto");
const Http = Npm.require("http");
const Https = Npm.require("https");
const Future = Npm.require("fibers/future");
const Net = Npm.require("net");
const Dgram = Npm.require("dgram");
const Promise = Npm.require("es6-promise").Promise;
const Capnp = Npm.require("capnp");

const EmailRpc = Capnp.importSystem("sandstorm/email.capnp");
const HackSessionContext = Capnp.importSystem("sandstorm/hack-session.capnp").HackSessionContext;
const Supervisor = Capnp.importSystem("sandstorm/supervisor.capnp").Supervisor;
const SystemPersistent = Capnp.importSystem("sandstorm/supervisor.capnp").SystemPersistent;
const IpRpc = Capnp.importSystem("sandstorm/ip.capnp");
const EmailSendPort = EmailRpc.EmailSendPort;
const Grain = Capnp.importSystem("sandstorm/grain.capnp");

const Url = Npm.require("url");

ROOT_URL = Url.parse(process.env.ROOT_URL);
HOSTNAME = ROOT_URL.hostname;

SessionContextImpl = class SessionContextImpl {
  constructor(grainId, sessionId, identityId, tabId) {
    this.grainId = grainId;
    this.sessionId = sessionId;
    this.identityId = identityId;
    this.tabId = tabId;
  }

  offer(cap, requiredPermissions, descriptor, displayInfo) {
    return inMeteor(() => {
      if (!this.identityId) {
        // TODO(soon): allow non logged in users?
        throw new Meteor.Error(400, "Only logged in users can offer capabilities.");
      }

      const castedCap = cap.castAs(SystemPersistent);
      let apiTokenOwner = { webkey: null };
      const isUiView = descriptor && descriptor.tags && descriptor.tags.length === 1 &&
          descriptor.tags[0] && descriptor.tags[0].id &&
          descriptor.tags[0].id === Grain.UiView.typeId;
      if (isUiView) {
        // TODO(cleanup): Mabye `SessionContextImpl` should have an `accountId` field.
        const accountId = (Sessions.findOne({ _id: this.sessionId }) || {}).userId;
        apiTokenOwner = {
          user: {
            identityId: this.identityId,
            title: globalDb.userGrainTitle(this.grainId, accountId, this.identityId),
            // The following fields will be overwritten by PersistentUiView.save(), so no need to
            // pass them in:
            //denormalizedGrainMetadata: {}, // This will look up the package for the grain referenced.
          },
        };
      }

      // TODO(soon): This will eventually use SystemPersistent.addRequirements when membranes
      // are fully implemented for supervisors.
      const requirement = {
        permissionsHeld: {
          grainId: this.grainId,
          identityId: this.identityId,
          permissions: requiredPermissions,
        },
      };

      if (!checkRequirements([requirement])) {
        throw new Meteor.Error(403, "Permissions not satisfied.");
      }

      const save = castedCap.save(apiTokenOwner);
      const sturdyRef = waitPromise(save).sturdyRef;
      ApiTokens.update({ _id: hashSturdyRef(sturdyRef) }, { $push: { requirements: requirement } });
      const powerboxView = isUiView ? {
        offer: {
          uiView: {
            token: sturdyRef.toString(),
            tokenId: hashSturdyRef(sturdyRef.toString()),
          },
        },
      } : {
        offer: {
          url: ROOT_URL.protocol + "//" + globalDb.makeApiHost(sturdyRef) + "#" + sturdyRef,
        },
      };
      Sessions.update({ _id: this.sessionId },
        {
          $set: {
            powerboxView: powerboxView,
          },
        },
      );
    });
  }
};

Meteor.methods({
  finishPowerboxRequest(webkeyUrl, saveLabel, identityId, grainId) {
    check(webkeyUrl, String);
    check(saveLabel, Match.OneOf(undefined, null, String));
    check(identityId, String);
    check(grainId, String);

    const userId = Meteor.userId();
    if (!userId || !globalDb.userHasIdentity(userId, identityId)) {
      throw new Meteor.Error(403, "Not an identity of the current user: " + identityId);
    }

    const parsedWebkey = Url.parse(webkeyUrl.trim());
    const hostId = matchWildcardHost(parsedWebkey.host);
    if (!hostId || !globalDb.isApiHostId(hostId)) {
      throw new Meteor.Error(500, "Hostname does not match this server. External webkeys are not " +
        "supported (yet)");
    }

    let token = parsedWebkey.hash;
    if (!token) {
      throw new Meteor.Error(400, "Invalid webkey. You must pass in the full webkey, " +
        "including domain name and hash fragment");
    }

    token = token.slice(1);
    if (globalDb.isTokenSpecificHostId(hostId) && hostId !== globalDb.apiHostIdForToken(token)) {
      // Note: This case is not security-sensitive. The client could easily compute the correct
      //   host ID for this token. But since they've passed one that doesn't match, we assume
      //   something is wrong and stop here.
      throw new Meteor.Error(400, "Invalid webkey: token doesn't match hostname.");
    }

    const cap = restoreInternal(new Buffer(token),
                                Match.Optional({ webkey: Match.Optional(Match.Any) }), []).cap;
    const castedCap = cap.castAs(SystemPersistent);
    const grainOwner = {
      grainId: grainId,
      introducerIdentity: identityId,
    };
    if (saveLabel) {
      grainOwner.saveLabel = {
        defaultText: saveLabel,
      };
    }

    const save = castedCap.save({ grain: grainOwner });
    const sturdyRef = waitPromise(save).sturdyRef;

    return sturdyRef.toString();
  },

  finishPowerboxOffer(sessionId) {
    check(sessionId, String);

    Sessions.update({ _id: sessionId }, { $unset: { powerboxView: null } });
  },

  getViewInfoForApiToken(apiTokenId) {
    check(apiTokenId, String);
    const token = globalDb.collections.apiTokens.findOne(apiTokenId);
    if (!token) {
      throw new Meteor.Error(400, "No such token.");
    }

    const grain = globalDb.collections.grains.findOne(token.grainId);
    if (!grain) {
      throw new Meteor.Error(500, "No grain found for token.");
    }

    return grain.cachedViewInfo;
  },
});

HackSessionContextImpl = class HackSessionContextImpl extends SessionContextImpl {
  constructor(grainId, sessionId, identityId, tabId) {
    super(grainId, sessionId, identityId, tabId);
  }

  _getPublicId() {
    // Get the grain's public ID, assigning a new one if it doesn't yet have one.
    //
    // Must be called in a Meteor context.

    while (!this.publicId) {
      // We haven't looked up the public ID yet.
      const grain = Grains.findOne(this.grainId, { fields: { publicId: 1 } });
      if (!grain) throw new Error("Grain does not exist.");

      if (grain.publicId) {
        this.publicId = grain.publicId;
      } else {
        // The grain doesn't have a public ID yet. Generate one.
        const candidate = generateRandomHostname(20);

        if (Grains.findOne({ publicId: candidate })) {
          // This should never ever happen.
          console.error("CRITICAL PROBLEM: Public ID collision. " +
                        "CSPRNG is bad or has insufficient entropy.");
          continue;
        }

        // Carefully perform an update that becomes a no-op if anyone else has assigned a public ID
        // simultaneously.
        if (Grains.update({ _id: this.grainId, publicId: { $exists: false } },
                          { $set: { publicId: candidate } }) > 0) {
          // We won the race.
          this.publicId = candidate;
        }
      }
    }

    return this.publicId;
  }

  _getAddress() {
    // Get the grain's outgoing e-mail address.
    //
    // Must be called in a Meteor context.

    return this._getPublicId() + "@" + HOSTNAME;
  }

  _getUserAddress() {
    // Get the user's e-mail address.
    //
    // Must be called in a Meteor context.

    const grain = Grains.findOne(this.grainId, { fields: { identityId: 1 } });

    const identity = globalDb.getIdentity(grain.identityId);

    const primaryEmail = _.findWhere(SandstormDb.getVerifiedEmails(identity), { primary: true });
    const email = (primaryEmail && primaryEmail.email) || identity.unverifiedEmail;

    const result = {};
    if (email) {
      result.address = email;
    }

    if (identity.profile.name) {
      result.name = identity.profile.name;
    }

    return result;
  }

  send(email) {
    return hackSendEmail(this, email);
  }

  getPublicId() {
    return inMeteor((function () {
      const result = {};

      result.publicId = this._getPublicId();
      result.hostname = HOSTNAME;
      result.autoUrl = ROOT_URL.protocol + "//" + makeWildcardHost(result.publicId);

      const grain = Grains.findOne(this.grainId, { fields: { userId: 1 } });
      result.isDemoUser = Meteor.users.findOne(grain.userId).expires ? true : false;

      return result;
    }).bind(this));
  }

  httpGet(url) {
    const _this = this;
    const session = _this;

    return new Promise((resolve, reject) => {
      let requestMethod = Http.request;
      if (url.indexOf("https://") === 0) {
        requestMethod = Https.request;
      } else if (url.indexOf("http://") !== 0) {
        err = new Error("Protocol not recognized.");
        err.nature = "precondition";
        reject(err);
      }

      req = requestMethod(url, (resp) => {
        const buffers = [];
        let err;

        switch (Math.floor(resp.statusCode / 100)) {
          case 2: // 2xx response -- OK.
            resp.on("data", (buf) => {
              buffers.push(buf);
            });

            resp.on("end", () => {
              resolve({
                content: Buffer.concat(buffers),
                mimeType: resp.headers["content-type"] || null,
              });
            });
            break;
          case 3: // 3xx response -- redirect.
            resolve(session.httpGet(resp.headers.location));
            break;
          case 4: // 4xx response -- client error.
            err = new Error("Status code " + resp.statusCode + " received in response.");
            err.nature = "precondition";
            reject(err);
            break;
          case 5: // 5xx response -- internal server error.
            err = new Error("Status code " + resp.statusCode + " received in response.");
            err.nature = "localBug";
            reject(err);
            break;
          default: // ???
            err = new Error("Invalid status code " + resp.statusCode + " received in response.");
            err.nature = "localBug";
            reject(err);
            break;
        }
      });

      req.on("error", (e) => {
        e.nature = "networkFailure";
        reject(e);
      });

      req.setTimeout(15000, () => {
        req.abort();
        err = new Error("Request timed out.");
        err.nature = "localBug";
        err.durability = "overloaded";
        reject(err);
      });

      req.end();
    });
  }

  getUserAddress() {
    return inMeteor((function () {
      return this._getUserAddress();
    }).bind(this));
  }

  obsoleteGenerateApiToken(petname, userInfo, expires) {
    throw new Error("generateApiToken() has been removed. Use offer templates instead.");
  }

  obsoleteListApiTokens() {
    throw new Error("listApiTokens() has been removed. Use offer templates instead.");
  }

  obsoleteRevokeApiToken(tokenId) {
    throw new Error("revokeApiToken() has been removed. Use offer templates instead.");
  }

  getUiViewForEndpoint(url) {
    const parsedUrl = Url.parse(url);

    if (parsedUrl.hash) { // Assume that anything with a fragment is a webkey
      if (parsedUrl.pathname) {
        throw new Error("Webkey urls cannot contain a path.");
      }

      const token = parsedUrl.hash.slice(1); // Get rid of # which is always the first character
      const hostId = matchWildcardHost(parsedUrl.host);
      if (hostId && globalDb.isApiHostId(hostId)) {
        // Connecting to a local capability.
        return getWrappedUiViewForToken(token);
      } else {
        // Connecting to a remote server with a bearer token.
        // TODO(someday): Negotiate server-to-server Cap'n Proto connection.
        return { view: new ExternalUiView(url, this.grainId, token) };
      }
    } else {
      return { view: new ExternalUiView(url, this.grainId) };
    }
  }
};

makeHackSessionContext = (grainId, sessionId, identityId, tabId) => {
  return new Capnp.Capability(new HackSessionContextImpl(grainId, sessionId, identityId, tabId),
                              HackSessionContext);
};

const HOSTNAME_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

generateRandomHostname = (length) => {
  // Generate a random unique name suitable for use in a hostname.

  const digits = [];
  for (let i = 0; i < length; i++) {
    digits[i] = Random.choice(HOSTNAME_CHARS);
  }

  return digits.join("");
};
