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

import Http from "http";
import Https from "https";
import Url from "url";

import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import { _ } from "meteor/underscore";
import { Random } from "meteor/random";

import { hashSturdyRef, checkRequirements, fetchApiToken } from "/imports/server/persistent.js";
import { inMeteor, waitPromise } from "/imports/server/async-helpers.ts";
import { ssrfSafeLookup } from "/imports/server/networking.js";
import Capnp from "/imports/server/capnp.js";
import { SandstormDb } from "/imports/sandstorm-db/db.js";
import { globalDb } from "/imports/db-deprecated.js";

const HackSessionContext = Capnp.importSystem("sandstorm/hack-session.capnp").HackSessionContext;
const SystemPersistent = Capnp.importSystem("sandstorm/supervisor.capnp").SystemPersistent;
const Grain = Capnp.importSystem("sandstorm/grain.capnp");
const Powerbox = Capnp.importSystem("sandstorm/powerbox.capnp");


const ROOT_URL = Url.parse(process.env.ROOT_URL);
const HOSTNAME = ROOT_URL.hostname;

class SessionContextImpl {
  constructor(grainId, sessionId, accountId, tabId) {
    this.grainId = grainId;
    this.sessionId = sessionId;
    this.accountId = accountId;
    this.tabId = tabId;
  }

  claimRequest(sturdyRef, requiredPermissions) {
    return inMeteor(() => {
      if (!this.sessionId) throw new Error("API sessions can't use powerbox");

      const token = fetchApiToken(globalDb, sturdyRef,
        { "owner.clientPowerboxRequest.sessionId": this.sessionId });

      if (!token) {
        throw new Error("no such token");
      }

      const session = globalDb.collections.sessions.findOne({ _id: this.sessionId });

      if (!session) {
        throw new Error("no such session");
      }

      // Honor `requiredPermissions`.
      const requirements = [];
      if (session.hashedToken) {
        // Session is authorized by token. Note that it's important to check this before accountId
        // e.g. in the case of standalone domains.
        requirements.push({
          permissionsHeld: {
            permissions: requiredPermissions || [],
            tokenId: session.hashedToken,
            grainId: this.grainId,
          },
        });
      } else if (session.identityId) {
        // Session is authorized by identity. (We check session.identityId rather than
        // session.userId because session.userId is set even for incognito sessions.)
        requirements.push({
          permissionsHeld: {
            permissions: requiredPermissions || [],
            accountId: session.userId,
            grainId: this.grainId,
          },
        });
      } else {
        // This can only happen with old-style sharing which has been deprecated for years. If
        // we wanted to support this, I suppose we could do so as long as requiredPermissions is
        // all-false? But probably this will never come up.
        throw new Error("Cannot accept powerbox request from anonymous session that " +
                        "doesn't have a token.");
      }

      return restoreInternal(
          globalDb, sturdyRef,
          { clientPowerboxRequest: Match.ObjectIncluding({ sessionId: this.sessionId }) },
          requirements, token);
    });
  }

  _offerOrFulfill(isFulfill, cap, requiredPermissions, descriptor, displayInfo) {
    return inMeteor(() => {
      if (!this.sessionId) throw new Error("API sessions can't use powerbox");

      const session = globalDb.collections.sessions.findOne({ _id: this.sessionId });

      if (!session.identityId && !session.hashedToken) {
        throw new Error("Session has neither an identityId nor a hashedToken.");
      }

      if (isFulfill && !session.powerboxRequest) {
        // Not a request session, so treat fulfillRequest() same as offer().
        isFulfill = false;
      }

      const castedCap = cap.castAs(SystemPersistent);
      let apiTokenOwner = { clientPowerboxOffer: { sessionId: this.sessionId, }, };
      const isUiView = descriptor && descriptor.tags && descriptor.tags.length === 1 &&
          descriptor.tags[0] && descriptor.tags[0].id &&
          descriptor.tags[0].id === Grain.UiView.typeId;
      if (isUiView) {
        let tagValue = {};
        if (descriptor.tags[0].value) {
          tagValue = Capnp.parse(Grain.UiView.PowerboxTag, descriptor.tags[0].value);
        }

        if (!tagValue.title) {
          throw new Error("No value provided for UiView.PowerboxTag.title.");
        }

        if (session.identityId) {
          apiTokenOwner = {
            user: {
              accountId: this.accountId,
              title: tagValue.title,
            },
          };
        }
      }

      if (isFulfill) {
        // The capability will pass directly to the requesting grain.
        apiTokenOwner = {
          clientPowerboxRequest: {
            sessionId: session.powerboxRequest.requestingSession,
          },
        };
      }

      // TODO(soon): This will eventually use SystemPersistent.addRequirements when membranes
      // are fully implemented for supervisors.
      const permissionsHeld = {
        grainId: this.grainId,
        permissions: requiredPermissions,
      };

      // Note that if both hashedToken and identityId are present, this indicates that the session
      // is authorized by a token which the user has NOT redeemed. Thus the identity does not
      // directly have access to the grain; the token does. (This is the case in particular for
      // standalone domains.) So clearly we want our requirement to be based on the token, not the
      // identity.
      if (session.hashedToken) {
        permissionsHeld.tokenId = session.hashedToken;
      } else if (session.identityId) {
        permissionsHeld.accountId = session.userId;
      } else {
        throw new Error("Cannot offer to anonymous session that does not have a token.");
      }

      const requirement = { permissionsHeld };

      checkRequirements(globalDb, [requirement]);

      const save = castedCap.save(apiTokenOwner);
      const sturdyRef = waitPromise(save).sturdyRef;
      globalDb.collections.apiTokens.update({ _id: hashSturdyRef(sturdyRef) }, { $push: { requirements: requirement } });

      let powerboxView;
      if (isFulfill) {
        powerboxView = {
          fulfill: {
            token: sturdyRef.toString(),
            descriptor: Capnp.serializePacked(Powerbox.PowerboxDescriptor, descriptor)
                             .toString("base64"),
          },
        };
      } else if (isUiView) {
        if (session.identityId) {
          // Deduplicate.
          const newApiToken = fetchApiToken(globalDb, sturdyRef.toString());
          let tokenId = newApiToken._id;
          const dupeQuery = _.pick(newApiToken, "grainId", "roleAssignment", "requirements",
                                   "parentToken", "parentTokenKey", "accountId", "accountId");
          dupeQuery._id = { $ne: newApiToken._id };
          dupeQuery["owner.user.accountId"] = this.accountId;
          dupeQuery.trashed = { $exists: false };
          dupeQuery.revoked = { $exists: false };

          const dupeToken = globalDb.collections.apiTokens.findOne(dupeQuery);
          if (dupeToken) {
            globalDb.removeApiTokens({ _id: tokenId });
            tokenId = dupeToken._id;
          }

          powerboxView = { offer: { uiView: { tokenId } } };
        } else {
          powerboxView = { offer: { uiView: { token: sturdyRef.toString() } } };
        }
      } else {
        powerboxView = {
          offer: {
            token: sturdyRef.toString(),
          },
        };
      }

      globalDb.collections.sessions.update({ _id: this.sessionId },
        {
          $set: {
            powerboxView: powerboxView,
          },
        },
      );
    });
  }

  offer(cap, requiredPermissions, descriptor, displayInfo) {
    return this._offerOrFulfill(false, cap, requiredPermissions, descriptor, displayInfo);
  }

  fulfillRequest(cap, requiredPermissions, descriptor, displayInfo) {
    return this._offerOrFulfill(true, cap, requiredPermissions, descriptor, displayInfo);
  }

  activity(event) {
    return inMeteor(() => {
      logActivity(this.grainId, this.accountId || "anonymous", event);
    });
  }
}

Meteor.methods({
  finishPowerboxRequest(sessionId, webkeyUrl, saveLabel, obsolete, grainId) {
    check(sessionId, String);
    check(webkeyUrl, String);
    check(saveLabel, Match.OneOf(undefined, null, String));
    check(grainId, String);

    const db = this.connection.sandstormDb;

    const userId = Meteor.userId();
    if (!userId) {
      throw new Meteor.Error(403, "Not logged in.");
    }

    const parsedWebkey = Url.parse(webkeyUrl.trim());
    const hostId = matchWildcardHost(parsedWebkey.host);
    if (!hostId || !db.isApiHostId(hostId)) {
      throw new Meteor.Error(500, "Hostname does not match this server. External webkeys are not " +
        "supported (yet)");
    }

    let token = parsedWebkey.hash;
    if (!token) {
      throw new Meteor.Error(400, "Invalid webkey. You must pass in the full webkey, " +
        "including domain name and hash fragment");
    }

    token = token.slice(1);
    if (db.isTokenSpecificHostId(hostId) && hostId !== db.apiHostIdForToken(token)) {
      // Note: This case is not security-sensitive. The client could easily compute the correct
      //   host ID for this token. But since they've passed one that doesn't match, we assume
      //   something is wrong and stop here.
      throw new Meteor.Error(400, "Invalid webkey: token doesn't match hostname.");
    }

    const cap = restoreInternal(db, token,
                                Match.Optional({ webkey: Match.Optional(Match.Any) }), []).cap;
    const castedCap = cap.castAs(SystemPersistent);
    const owner = {
      clientPowerboxRequest: {
        grainId: grainId,
        sessionId: sessionId,
      },
    };
    if (saveLabel) {
      grainOwner.saveLabel = {
        defaultText: saveLabel,
      };
    }

    const save = castedCap.save(owner);
    const sturdyRef = waitPromise(save).sturdyRef;
    return sturdyRef.toString();
  },

  finishPowerboxOffer(sessionId) {
    check(sessionId, String);

    globalDb.collections.sessions.update({ _id: sessionId }, { $unset: { powerboxView: null } });
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

class HackSessionContextImpl extends SessionContextImpl {
  constructor(grainId, sessionId, accountId, tabId) {
    super(grainId, sessionId, accountId, tabId);
  }

  _getPublicId() {
    // Get the grain's public ID, assigning a new one if it doesn't yet have one.
    //
    // Must be called in a Meteor context.

    while (!this.publicId) {
      // We haven't looked up the public ID yet.
      const grain = globalDb.collections.grains.findOne(this.grainId, { fields: { publicId: 1 } });
      if (!grain) throw new Error("Grain does not exist.");

      if (grain.publicId) {
        this.publicId = grain.publicId;
      } else {
        // The grain doesn't have a public ID yet. Generate one.
        const candidate = generateRandomHostname(20);

        if (globalDb.collections.grains.findOne({ publicId: candidate })) {
          // This should never ever happen.
          console.error("CRITICAL PROBLEM: Public ID collision. " +
                        "CSPRNG is bad or has insufficient entropy.");
          continue;
        }

        // Carefully perform an update that becomes a no-op if anyone else has assigned a public ID
        // simultaneously.
        if (globalDb.collections.grains.update({ _id: this.grainId, publicId: { $exists: false } },
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

    const grain = globalDb.collections.grains.findOne(this.grainId, { fields: { userId: 1 } });

    const user = Meteor.users.findOne({_id: grain.userId});

    const email = _.findWhere(SandstormDb.getUserEmails(user), { primary: true });

    const result = {};
    if (email) {
      result.address = email.email;
    }

    if (user.profile.name) {
      result.name = user.profile.name;
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

      const grain = globalDb.collections.grains.findOne(this.grainId, { fields: { userId: 1 } });
      result.isDemoUser = Meteor.users.findOne(grain.userId).expires ? true : false;

      return result;
    }).bind(this));
  }

  obsoleteHttpGet(url) {
    const _this = this;
    const session = _this;

    return inMeteor(() => {
      if(!globalDb.allowLegacyHackSessionHttp()) {
        throw new Error(
          "HackSession.httpGet() is disabled and will be permanently removed soon. " +
          "You should port your app to to use the powerbox instead. If you need " +
          "help figuring out how to transition, please contact us via the " +
          "sandstorm-dev@googlegroups.com mailing list."
        )
      }
      return ssrfSafeLookup(globalDb, url);
    }).then(safe => {
      return new Promise((resolve, reject) => {
        let requestMethod = Http.request;
        if (safe.url.indexOf("https://") === 0) {
          requestMethod = Https.request;
        } else if (safe.url.indexOf("http://") !== 0) {
          const err = new Error("Protocol not recognized.");
          err.nature = "precondition";
          reject(err);
        }

        const options = Url.parse(safe.url);
        options.headers = { host: safe.host };
        options.servername = safe.host.split(":")[0];

        const req = requestMethod(options, (resp) => {
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
              resolve(session.obsoleteHttpGet(resp.headers.location));
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
          const err = new Error("Request timed out.");
          err.nature = "localBug";
          err.durability = "overloaded";
          reject(err);
        });

        req.end();
      });
    });
  }

  getUserAddress() {
    return inMeteor((function () {
      return this._getUserAddress();
    }).bind(this));
  }

  obsoleteGenerateApiToken(_petname, _userInfo, _expires) {
    throw new Error("generateApiToken() has been removed. Use offer templates instead.");
  }

  obsoleteListApiTokens() {
    throw new Error("listApiTokens() has been removed. Use offer templates instead.");
  }

  obsoleteRevokeApiToken(_tokenId) {
    throw new Error("revokeApiToken() has been removed. Use offer templates instead.");
  }

  obsoleteGetUiViewForEndpoint(url) {
    return inMeteor(() => {
      if(!globalDb.allowLegacyHackSessionHttp()) {
        throw new Error(
          "HackSession.getUiViewForEndpoint() is disabled and will be permanently removed soon. " +
          "You should port your app to to use the powerbox instead. If you need " +
          "help figuring out how to transition, please contact us via the " +
          "sandstorm-dev@googlegroups.com mailing list."
        )
      }

      const parsedUrl = Url.parse(url);

      if (parsedUrl.hash) { // Assume that anything with a fragment is a webkey
        if (parsedUrl.pathname && parsedUrl.pathname !== "/") {
          throw new Error("Webkey urls cannot contain a path.");
        }

        const token = parsedUrl.hash.slice(1); // Get rid of # which is always the first character
        const hostId = matchWildcardHost(parsedUrl.host);
        // Connecting to a remote server with a bearer token.
        // TODO(someday): Negotiate server-to-server Cap'n Proto connection.
        return { view: new ExternalUiView(url, token) };
      } else {
        return { view: new ExternalUiView(url) };
      }
    })
  }
}

export const makeHackSessionContext = (grainId, sessionId, accountId, tabId) => {
  // TODO(security): Ensure that the session context is revoked if the session is revoked.
  return new Capnp.Capability(new HackSessionContextImpl(grainId, sessionId, accountId, tabId),
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
