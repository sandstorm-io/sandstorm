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

var Crypto = Npm.require("crypto");
var Http = Npm.require("http");
var Https = Npm.require("https");
var Future = Npm.require("fibers/future");
var Net = Npm.require("net");
var Dgram = Npm.require("dgram");
var Promise = Npm.require("es6-promise").Promise;
var Capnp = Npm.require("capnp");

var EmailRpc = Capnp.importSystem("sandstorm/email.capnp");
var HackSessionContext = Capnp.importSystem("sandstorm/hack-session.capnp").HackSessionContext;
var PowerboxCapability = Capnp.importSystem("sandstorm/grain.capnp").PowerboxCapability;
var Supervisor = Capnp.importSystem("sandstorm/supervisor.capnp").Supervisor;
var SystemPersistent = Capnp.importSystem("sandstorm/supervisor.capnp").SystemPersistent;
var IpRpc = Capnp.importSystem("sandstorm/ip.capnp");
var EmailSendPort = EmailRpc.EmailSendPort;

var Url = Npm.require("url");

var ROOT_URL = Url.parse(process.env.ROOT_URL);
HOSTNAME = ROOT_URL.hostname;

function SessionContextImpl(grainId, sessionId) {
  this.grainId = grainId;
  this.sessionId = sessionId;
}

SessionContextImpl.prototype.offer = function (cap, requiredPermissions) {
  // TODO(someday): do something with requiredPermissions
  var self = this;
  return inMeteor((function () {
    var castedCap = cap.castAs(SystemPersistent);
    var save = castedCap.save();
    var sturdyRef = waitPromise(save).sturdyRef;
    Sessions.update({_id: self.sessionId}, {$set: {
      powerboxView: {
        offer: ROOT_URL.protocol + "//" + makeWildcardHost("api") + "#" + sturdyRef
      }
    }});
  }));
};

Meteor.methods({
  finishPowerboxRequest: function (webkeyUrl, grainId) {
    check(webkeyUrl, String);
    check(grainId, String);

    var parsedWebkey = Url.parse(webkeyUrl.trim());
    if (parsedWebkey.host !== makeWildcardHost("api")) {
      console.log(parsedWebkey.hostname, makeWildcardHost("api"));
      throw new Meteor.Error(500, "Hostname does not match this server. External webkeys are not " +
        "supported (yet)");
    }

    var token = parsedWebkey.hash;
    if (!token) {
      throw new Meteor.Error(500, "Invalid webkey. You must pass in the full webkey, " +
        "including domain name and hash fragment");
    }
    token = token.slice(1);

    var cap;
    try {
      cap = waitPromise(restoreInternal(token,
                                        Match.Optional({webkey: Match.Optional(Match.Any)}))).cap;
    } catch (err) {
      throw new Meteor.Error(500, err.toString());
    }
    var castedCap = cap.castAs(SystemPersistent);
    var save = castedCap.save({grain: {
      grainId: grainId,
      saveLabel: {
        defaultText: "Requested Powerbox Capability"
      }
    }});
    var sturdyRef = waitPromise(save).sturdyRef;
    return sturdyRef.toString();
  },
  finishPowerboxOffer: function (sessionId) {
    check(sessionId, String);

    Sessions.update({_id: sessionId, userId: Meteor.userId()}, {$unset: {powerboxView: null}});
  }
});

function HackSessionContextImpl(grainId, sessionId) {
  SessionContextImpl.call(this, grainId, sessionId);
}

HackSessionContextImpl.prototype = Object.create(SessionContextImpl.prototype);
HackSessionContextImpl.prototype.constructor = HackSessionContextImpl;

makeHackSessionContext = function (grainId, sessionId) {
  return new Capnp.Capability(new HackSessionContextImpl(grainId, sessionId), HackSessionContext);
};

var HOSTNAME_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

generateRandomHostname = function(length) {
  // Generate a random unique name suitable for use in a hostname.

  var digits = [];
  for (var i = 0; i < length; i++) {
    digits[i] = Random.choice(HOSTNAME_CHARS);
  }
  return digits.join("");
};

HackSessionContextImpl.prototype._getPublicId = function () {
  // Get the grain's public ID, assigning a new one if it doesn't yet have one.
  //
  // Must be called in a Meteor context.

  while (!this.publicId) {
    // We haven't looked up the public ID yet.
    var grain = Grains.findOne(this.grainId, {fields: {publicId: 1, userId: 1}});
    if (!grain) throw new Error("Grain does not exist.");

    this.userId = grain.userId;

    if (grain.publicId) {
      this.publicId = grain.publicId;
    } else {
      // The grain doesn't have a public ID yet. Generate one.
      var candidate = generateRandomHostname(20);

      if (Grains.findOne({publicId: candidate})) {
        // This should never ever happen.
        console.error("CRITICAL PROBLEM: Public ID collision. " +
                      "CSPRNG is bad or has insufficient entropy.");
        continue;
      }

      // Carefully perform an update that becomes a no-op if anyone else has assigned a public ID
      // simultaneously.
      if (Grains.update({_id: this.grainId, publicId: { $exists: false }},
                        { $set: { publicId: candidate } }) > 0) {
        // We won the race.
        this.publicId = candidate;
      }
    }
  }

  return this.publicId;
};

HackSessionContextImpl.prototype._getAddress = function () {
  // Get the grain's outgoing e-mail address.
  //
  // Must be called in a Meteor context.

  return this._getPublicId() + "@" + HOSTNAME;
};

HackSessionContextImpl.prototype._getUserAddress = function () {
  // Get the user's e-mail address.
  //
  // Must be called in a Meteor context.

  var grain = Grains.findOne(this.grainId, {fields: {userId: 1}});
  var user = Meteor.users.findOne(grain.userId);

  var email = (user.emails && user.emails.length && user.emails[0].address) || (user.services.google && user.services.google.email) || (user.services.github && user.services.github.email);

  var result = {};
  if (email) {
    result.address = email;
  }
  if (user.profile.name) {
    result.name = user.profile.name;
  }

  return result;
};

HackSessionContextImpl.prototype.send = function (email) {
  return hackSendEmail(this, email);
};

HackSessionContextImpl.prototype.getPublicId = function() {
  return inMeteor((function () {
    var result = {};

    result.publicId = this._getPublicId();
    result.hostname = HOSTNAME;
    result.autoUrl = ROOT_URL.protocol + "//" + makeWildcardHost(result.publicId);

    var grain = Grains.findOne(this.grainId, {fields: {userId: 1}});
    result.isDemoUser = Meteor.users.findOne(grain.userId).expires ? true : false;

    return result;
  }).bind(this));
};

HackSessionContextImpl.prototype.httpGet = function(url) {
  var session = this;

  return new Promise(function (resolve, reject) {
    var requestMethod = Http.request;
    if (url.indexOf("https://") === 0) {
      requestMethod = Https.request;
    } else if (url.indexOf("http://") !== 0) {
      err = new Error("Protocol not recognized.");
      err.nature = "precondition";
      reject(err);
    }
    req = requestMethod(url, function (resp) {
      var buffers = [];
      var err;

      switch (Math.floor(resp.statusCode / 100)) {
        case 2:
          // 2xx response -- OK.
          resp.on("data", function (buf) {
            buffers.push(buf);
          });

          resp.on("end", function() {
            resolve({
              content: Buffer.concat(buffers),
              mimeType: resp.headers["content-type"] || null
            });
          });
          break;
        case 3:
          // 3xx response -- redirect.
          resolve(session.httpGet(resp.headers.location));
          break;
        case 4:
          // 4xx response -- client error.
          err = new Error("Status code " + resp.statusCode + " received in response.");
          err.nature = "precondition";
          reject(err);
          break;
        case 5:
          // 5xx response -- internal server error.
          err = new Error("Status code " + resp.statusCode + " received in response.");
          err.nature = "localBug";
          reject(err);
          break;
        default:
          // ???
          err = new Error("Invalid status code " + resp.statusCode + " received in response.");
          err.nature = "localBug";
          reject(err);
          break;
      }
    });

    req.on("error", function (e) {
      e.nature = "networkFailure";
      reject(e);
    });

    req.setTimeout(15000, function () {
      req.abort();
      err = new Error("Request timed out.");
      err.nature = "localBug";
      err.durability = "overloaded";
      reject(err);
    });

    req.end();
  });
};

HackSessionContextImpl.prototype.getUserAddress = function () {
  return inMeteor((function () {
    return this._getUserAddress();
  }).bind(this));
};

HackSessionContextImpl.prototype.generateApiToken = function (petname, userInfo, expires) {
  return inMeteor((function () {
    var token = Random.secret();
    var endpointUrl = ROOT_URL.protocol + "//" + makeWildcardHost("api");

    var tokenId = ApiTokens.insert({
      _id: Crypto.createHash("sha256").update(token).digest("base64"),
      userInfo: userInfo,
      grainId: this.grainId,
      petname: petname,
      created: new Date(),
      expires: expires > 0 ? new Date(expires * 1000) : null
    });

    return [token, endpointUrl, tokenId];
  }).bind(this));
};

Meteor.methods({
  newApiToken: function (grainId, petname, roleAssignment, forSharing, destroyIfNotUsedByTime) {
    // Create a new user-oriented API token.
    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to create an API token.");
    }

    check(grainId, String);
    check(petname, String);
    check(forSharing, Boolean);
    check(roleAssignment, {
      none : Match.Optional(null),
      allAccess: Match.Optional(null),
      roleId: Match.Optional(Match.Integer),
    });
    // Meteor bug #3877: we get null here instead of undefined when we
    // explicitly pass in undefined.
    if (destroyIfNotUsedByTime) {
      check(destroyIfNotUsedByTime, Number);
    }
    var selfDestructAt = (destroyIfNotUsedByTime && (destroyIfNotUsedByTime > 0)) ?
        new Date(destroyIfNotUsedByTime) : null;

    var grain = Grains.findOne(grainId);
    if (!grain) {
      throw new Meteor.Error(403, "Unauthorized", "No grain found.");
    }

    var token = Random.secret();
    var endpointUrl = ROOT_URL.protocol + "//" + makeWildcardHost("api");

    ApiTokens.insert({
      _id: Crypto.createHash("sha256").update(token).digest("base64"),
      userId: this.userId,
      grainId: grainId,
      roleAssignment: roleAssignment,
      petname: petname,
      created: new Date(),
      expires: null,
      forSharing: forSharing,
      expiresIfUnused: selfDestructAt
    });

    return {token: token, endpointUrl: endpointUrl};
  }
});

var cleanupSelfDestructing = function() {
  var now = new Date();
  ApiTokens.remove({expiresIfUnused: {$lt: now}});
};

// Make self-destructing tokens actually self-destruct, so they don't
// clutter the token list view.
Meteor.setInterval(cleanupSelfDestructing, 60 * 1000);

HackSessionContextImpl.prototype.listApiTokens = function () {
  return inMeteor((function () {
    results = [];
    ApiTokens.find({grainId: this.grainId, userInfo: {$exists: true}})
        .forEach(function (token) {
      if (token.expires && token.expires.getTime() < Date.now()) {
        // Skip.
        return;
      }

      // Hack: When Mongo stores a Buffer, it comes back as some other type.
      if ("userId" in token.userInfo) {
        token.userInfo.userId = new Buffer(token.userInfo.userId);
      }
      results.push({
        tokenId: token._id,
        petname: token.petname,
        userInfo: token.userInfo
      });
    });

    return [results];
  }).bind(this));
};

HackSessionContextImpl.prototype.revokeApiToken = function (tokenId) {
  return inMeteor((function () {
    if (ApiTokens.remove({_id: tokenId, grainId: this.grainId, userInfo: {$exists: true}}) === 0) {
      var err = new Error("No such token.");
      err.nature = "precondition";
      throw err;
    }
  }).bind(this));
};

HackSessionContextImpl.prototype.getIpInterface = function () {
  return inMeteor((function () {
    var grain = Grains.findOne(this.grainId, {fields: {userId: 1}});
    var user = Meteor.users.findOne(grain.userId);

    if (!user.isAdmin) {
      throw new Error("This grain's owner does not have adequate permissions to call getIpInterface");
    }

    return {interface: new IpInterfaceImpl()};
  }).bind(this));
};

HackSessionContextImpl.prototype.getIpNetwork = function () {
  return inMeteor((function () {
    var grain = Grains.findOne(this.grainId, {fields: {userId: 1}});
    var user = Meteor.users.findOne(grain.userId);

    if (!user.isAdmin) {
      throw new Error("This grain's owner does not have adequate permissions to call getIpInterface");
    }

    return {network: new IpNetworkImpl()};
  }).bind(this));
};

HackSessionContextImpl.prototype.getUiViewForEndpoint = function (url) {
  var parsedUrl = Url.parse(url);

  if (parsedUrl.hash) { // Assume that anything with a fragment is a webkey
    if (parsedUrl.pathname) {
      throw new Error("Webkey urls cannot contain a path.");
    }
    var apiHost = ROOT_URL.protocol + "//" + makeWildcardHost("api");
    var urlProtoAndHost = parsedUrl.protocol + "//" + parsedUrl.host;
    var token = parsedUrl.hash.slice(1); // Get rid of # which is always the first character
    if (urlProtoAndHost === apiHost) {
      return getWrappedUiViewForToken(token);
    } else {
      return {view: new ExternalUiView(url, this.grainId, token)};
    }
  } else {
    return {view: new ExternalUiView(url, this.grainId)};
  }
};
