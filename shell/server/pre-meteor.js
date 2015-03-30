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

// This file implements logic that we place in front of our main Meteor application,
// including routing of requests to proxies and handling of static web publishing.

var Url = Npm.require("url");
var Fs = Npm.require("fs");
var Dns = Npm.require("dns");
var Promise = Npm.require("es6-promise").Promise;
var HOSTNAME = Url.parse(process.env.ROOT_URL).hostname;
var DDP_HOSTNAME = process.env.DDP_DEFAULT_CONNECTION_URL &&
    Url.parse(process.env.DDP_DEFAULT_CONNECTION_URL).hostname;
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

function isSandstormShell(hostname) {
  // Is this hostname mapped to the Sandstorm shell?

  return (hostname === HOSTNAME || (DDP_HOSTNAME && hostname === DDP_HOSTNAME));
}

Meteor.startup(function () {

  var meteorUpgradeListeners = WebApp.httpServer.listeners('upgrade');
  WebApp.httpServer.removeAllListeners('upgrade');

  WebApp.httpServer.on('upgrade', function(req, socket, head) {
    try {
      if (isSandstormShell(req.headers.host.split(":")[0])) {
        // Go on to Meteor.
        for (var ii = 0; ii < meteorUpgradeListeners.length; ++ii) {
          meteorUpgradeListeners[ii](req, socket, head);
        }
      } else {
        var id = matchWildcardHost(req.headers.host);
        if (id) {
          if (!tryProxyUpgrade(id, req, socket, head)) {
            socket.destroy();
          }
        }
      }
    } catch (err) {
      console.error("WebSocket event handler failed:", err.stack);
    }
  });

  WebApp.rawConnectHandlers.use(function (req, res, next) {
    var hostname = req.headers.host.split(":")[0];
    if (isSandstormShell(hostname)) {
      // Go on to Meteor.
      return next();
    }

    // This is not our main host. See if it's a member of the wildcard.
    var publicIdPromise;

    var id = matchWildcardHost(req.headers.host);
    if (id) {
      // Match!

      // First, try to route the request to a session.
      if (tryProxyRequest(id, req, res)) {
        return;
      }

      publicIdPromise = Promise.resolve(id);
    } else {
      // Not a wildcard host. Perhaps it is a custom host.
      publicIdPromise = lookupPublicIdFromDns(hostname);
    }

    publicIdPromise.then(function (publicId) {
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
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(err.message);
    });
  });
});

var errorTxtMapping = {};
errorTxtMapping[Dns.NOTFOUND] = "<br>\n" +
    "If you were trying to connect this address to a Sandstorm app hosted at this server,<br>\n" +
    "you either have not set your DNS TXT records correctly or the DNS cache has not<br>\n" +
    "updated yet (may take a while).<br>\n";
errorTxtMapping[Dns.NODATA] = errorTxtMapping[Dns.NOTFOUND];
errorTxtMapping[Dns.TIMEOUT] = "<br>\n" +
    "The DNS query has timed out, which may be a sign of poorly configured DNS on the server.<br>\n";
errorTxtMapping[Dns.CONNREFUSED] = "<br>\n" +
    "The DNS server refused the connection, which means either your DNS server is down/unreachable,<br>\n" +
    "or the server has misconfigured their DNS.<br>\n";

function lookupPublicIdFromDns(hostname) {
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

  var cache = dnsCache[hostname];
  if (cache && Date.now() < cache.expiration) {
    return Promise.resolve(cache.value);
  }

  return new Promise(function (resolve, reject) {
    Dns.resolveTxt("sandstorm-www." + hostname, function (err, records) {
      if (err) {
        var errorMsg = errorTxtMapping[err.code] || "";
        reject(new Error(
          "<p>Error looking up DNS TXT records for host '" + hostname + "': " + err.message + "<br>\n" +
          "<br>\n" +
          "This Sandstorm server's main interface is at: <a href=\"" + process.env.ROOT_URL + "\">" +
          process.env.ROOT_URL + "</a><br>\n" +
          errorMsg +
          "<br>\n" +
          "If you are the server admin and want to use this address as the main interface,<br>\n" +
          "edit /opt/sandstorm/sandstorm.conf, modify the BASE_URL setting, and restart.<br>\n" +
          "<br>\n" +
          "If you got here after trying to log in via OAuth (e.g. through Github or Google),<br>\n" +
          "the problem is probably that the OAuth callback URL was set wrong. You need to<br>\n" +
          "update it through the respective login provider's management console.</p>"));
      } else if (records.length !== 1) {
        reject(new Error("Host 'sandstorm-www." + hostname + "' must have exactly one TXT record."));
      } else {
        var result = records[0];
        dnsCache[hostname] = { value: result, expiration: Date.now() + DNS_CACHE_TTL };
        resolve(result);
      }
    });
  });
}
