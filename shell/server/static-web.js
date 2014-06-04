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
    }).catch(function (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(err.message);
    });
  });
});

function lookupPublicIdFromDns(host) {
  // Given a hostname, determine its public ID.
  // We look for a TXT record indicating the public ID. Unfortunately, according to spec, a single
  // hostname cannot have both a CNAME and a TXT record, because a TXT lookup on a CNAME'd host
  // should actually be redirected to the CNAME, just like an A lookup would be. In practice lots
  // of DNS software actually allows TXT records on CNAMEs, and it seems to work, but some software
  // does not allow it and it's explicitly disallowed by the spec. Therefore, we instead look for
  // the TXT record on a subdomain.
  //
  // I also considered having the CNAME itself point to <publicId>.<hostname>, where
  // *.<hostname> is in turn a CNAME for the Sandstorm server. This approach seemed elegant at
  // first, but has a number of problems, the biggest being that it breaks the ability to place a
  // CDN like CloudFlare in front of the site.

  var cache = dnsCache[host];
  if (cache && Date.now() < cache.expiration) {
    return Promise.resolve(cache.value);
  }

  return new Promise(function (resolve, reject) {
    Dns.resolveTxt("sandstorm-www." + host, function (err, records) {
      if (err) {
        reject(err);
      } else if (records.length !== 1) {
        reject(new Error("Host 'sandstorm-www." + host + "' must have exactly one TXT record."));
      } else {
        var result = records[0];
        dnsCache[host] = { value: result, expiration: Date.now() + DNS_CACHE_TTL };
        resolve(result);
      }
    });
  });
}
