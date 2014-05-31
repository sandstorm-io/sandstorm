// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// This file is part of the Sandstorm platform implementation.
//
// Sandstorm is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Sandstorm is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public
// License along with Sandstorm.  If not, see
// <http://www.gnu.org/licenses/>.

// This file implements static web publishing.

var Url = Npm.require("url");
var Fs = Npm.require("fs");
var Dns = Npm.require("dns");
var HOSTNAME = Url.parse(process.env.ROOT_URL).hostname;
var CACHE_TTL = 30 * 1000;  // 30 seconds
var DNS_CACHE_TTL = CACHE_TTL;

var staticHandlers = {};
// Maps grain public IDs to Connect handlers.
// TODO(perf): Garbage-collect this map?

var dnsCache = {};
// Unfortunately, node's DNS library doesn't cache results, so we do our own caching.
// Unfortunately, node's DNS library also dosen't give us TTLs. So, we'll cache for
// DNS_CACHE_TTL (a relatively small value) and rely on the upstream DNS server to implement
// better caching.

Meteor.startup(function () {
  WebApp.rawConnectHandlers.use(function (req, res, next) {
    var host = req.headers.host;
    var colonPos = host.indexOf(":");
    if (colonPos >= 0) {
      host = host.slice(0, colonPos);
    }

    if (host === HOSTNAME) {
      // Go on to Meteor.
      return next();
    }

    // This is not Sandstorm's hostname! Perhaps it is a custom host.
    lookupPublicIdFromDns(host).then(function (publicId) {
      var handler = staticHandlers[publicId];
      if (handler) {
        return handler;
      } else {
        // We don't have a handler for this publicId, so look it up in the grain DB.
        return inMeteor(function () {
          var grain = Grains.findOne({publicId: publicId}, {fields: {_id: 1}});
          if (!grain) {
            throw new Error("No such grain for public ID: " + publicId);
          }
          var grainId = grain._id;

          var dir = SANDSTORM_GRAINDIR + "/" + grainId + "/sandbox/www";
          if (!Fs.existsSync(dir)) {
            throw new Error("Grain does not have a /var/www directory.");
          }
          return staticHandlers[publicId] = Connect.static(dir, {maxAge: CACHE_TTL});
        });
      }
    }).then(function (handler) {
      handler(req, res, function (err) {
        if (err) {
          next(err);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("404 not found: " + req.url);
        }
      });
    }).catch(next);
  });
});

function lookupPublicIdFromDns(host) {
  var cache = dnsCache[host];
  if (cache && Date.now() < cache.expiration) {
    return Promise.resolve(cache.value);
  }

  return new Promise(function (resolve, reject) {
    Dns.resolveTxt(host, function (err, records) {
      if (err) {
        reject(new Error("Error looking up DNS TXT records for host '" +
                         host + "': " + err.message));
      } else {
        resolve(records);
      }
    });
  }).then(function (records) {
    for (var i in records) {
      var record = records[i].trim();
      if (record.lastIndexOf("sandstorm-www=", 0) === 0) {
        var result = record.slice("sandstorm-www=".length);
        dnsCache[host] = { value: result, expiration: Date.now() + DNS_CACHE_TTL };
        return result;
      }
    }
    throw new Error("Host '" + host + "' has no 'sandstorm-www=' TXT record.");
  });
}
