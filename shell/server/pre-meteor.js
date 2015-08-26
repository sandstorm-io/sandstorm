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
var Future = Npm.require("fibers/future");

var HOSTNAME = Url.parse(process.env.ROOT_URL).hostname;
var DDP_HOSTNAME = process.env.DDP_DEFAULT_CONNECTION_URL &&
    Url.parse(process.env.DDP_DEFAULT_CONNECTION_URL).hostname;
var CACHE_TTL_SECONDS = 30;  // 30 seconds.  Cache-Control expects units of seconds, not millis.
var DNS_CACHE_TTL = CACHE_TTL_SECONDS * 1000; // DNS cache is in millis.

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

var mime = Connect.static.mime;

function wwwHandlerForGrain(grainId) {
  return function (request, response, cb) {
    var path = request.url;

    // If a directory, open "index.html".
    if (path.slice(-1) === "/") {
      path = path + "index.html";
    }

    // Strip leading '/'.
    if (path[0] === '/') path = path.slice(1);

    // Strip query.
    path = path.split("?")[0];

    var type = mime.lookup(path);
    var charset = mime.charsets.lookup(type);
    if (charset) {
      type = type + "; charset=" + charset;
    }

    var started = false;
    var sawEnd = false;

    // TODO(perf): Automatically gzip text content? Use Express's "compress" middleware for this?
    //   Note that nginx will also auto-compress things...

    var headers = {
      "Content-Type": type,
      "Cache-Control": "public, max-age=" + CACHE_TTL_SECONDS
    };

    if (path === "apps/index.json" ||
        path.match(/apps\/[a-z0-9]{52}[.]json/)) {
      // TODO(cleanup): Extra special terrible hack: The app index needs to serve these JSON files
      //   cross-origin. We could almost just make all web sites allow cross-origin since generally
      //   web publishing is meant to publish public content. There is one case where this is
      //   problematic, though: sites behind a firewall. Those sites could potentially be read
      //   by outside sites if CORS is enabled on them. Some day we should make it so apps can
      //   explicitly opt-in to allowing cross-origin queries but that day is not today.
      headers["Access-Control-Allow-Origin"] = "*";
    }

    var stream = {
      expectSize: function (size) {
        if (!started) {
          started = true;
          response.writeHead(200, _.extend(headers, { "Content-Length": size }));
        }
      },
      write: function (data) {
        if (!started) {
          started = true;
          response.writeHead(200, headers);
        }
        response.write(data);
      },
      done: function (data) {
        if (!started) {
          started = true;
          response.writeHead(200, _.extend(headers, { "Content-Length": 0, }));
        }
        sawEnd = true;
        response.end();
      }
    };

    useGrain(grainId, function (supervisor) {
      return supervisor.getWwwFileHack(path, stream)
          .then(function (result) {
        var status = result.status;
        if (status === "file") {
          if (!sawEnd) {
            console.error("getWwwFileHack didn't write file to stream");
            if (!started) {
              response.writeHead(500, {
                "Content-Type": "text/plain",
              });
              response.end("Internal server error");
            }
            response.end();
          }
        } else if (status === "directory") {
          if (started) {
            console.error("getWwwFileHack wrote to stream for directory");
            if (!sawEnd) {
              response.end();
            }
          } else {
            response.writeHead(303, {
              "Content-Type": "text/plain",
              "Location": "/" + path + "/",
              "Cache-Control": "public, max-age=" + CACHE_TTL_SECONDS
            });
            response.end("redirect: /" + path + "/");
          }
        } else if (status === "notFound") {
          if (started) {
            console.error("getWwwFileHack wrote to stream for notFound");
            if (!sawEnd) {
              response.end();
            }
          } else {
            response.writeHead(404, {
              "Content-Type": "text/plain"
            });
            response.end("404 not found: /" + path);
          }
        } else {
          console.error("didn't understand result of getWwwFileHack:", status);
          if (!started) {
            response.writeHead(500, {
              "Content-Type": "text/plain",
            });
            response.end("Internal server error");
          }
        }
      });
    }).catch(function (err) {
      console.error(err.stack);
    });
  };
}

function writeErrorResponse(res, err) {
  var status = 500;
  if (err instanceof Meteor.Error && typeof err.error === "number" &&
      err.error >= 400 && err.error < 600) {
    status = err.error;
  } else if (err.httpErrorCode) {
    status = err.httpErrorCode;
  }

  // Log errors that are our fault, but not errors that are the client's fault.
  if (status >= 500) console.error(err.stack);

  res.writeHead(status, { "Content-Type": err.htmlMessage ? "text/html" : "text/plain" });
  res.end(err.htmlMessage || err.message);
}

var PNG_MAGIC = new Buffer([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
var JPEG_MAGIC = new Buffer([0xFF, 0xD8, 0xFF]);

function checkMagic(buf, magic) {
  if (buf.length < magic.length) return false;
  for (var i = 0; i < magic.length; i++) {
    if (buf[i] != magic[i]) return false;
  }
  return true;
}

function serveStaticAsset(req, res) {
  inMeteor(function () {
    if (req.method === "GET") {
      var assetCspHeader = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
      if (req.headers["if-none-match"] === "permanent") {
        // Cache never invalidates since we use a new URL for every resource.
        res.writeHead(304, {
          "Cache-Control": "public, max-age=31536000",
          "ETag": "permanent",

          // To be safe, send these again, although it shouldn't be necessary.
          "Content-Security-Policy": assetCspHeader,
          "Access-Control-Allow-Origin": "*",
          "X-Content-Type-Options": "nosniff",
        });
        res.end();
        return;
      }

      var url = Url.parse(req.url);
      var asset = globalDb.getStaticAsset(url.pathname.slice(1));

      if (asset) {
        var headers = {
          "Content-Type": asset.mimeType,
          "Content-Length": asset.content.length,

          // Assets can be cached forever because each one has a unique ID.
          "Cache-Control": "public, max-age=31536000",

          // Since different resources get different URLs, we can use a static etag.
          "ETag": "permanent",

          // Set strict Content-Security-Policy to prevent static assets from executing any script
          // or doing basically anything when browsed to directly. The static assets host is not
          // intended to serve HTML. Mostly, it serves images and javascript -- note that setting
          // the CSP header on Javascript files does not prevent other hosts from voluntarily
          // specifying these scripts in <script> tags.
          "Content-Security-Policy": assetCspHeader,

          // Allow any host to fetch these assets. This is safe since requests to this host are
          // totally side-effect-free and the asset ID acts as a capability to prevent loading
          // assets you're not supposed to know about.
          "Access-Control-Allow-Origin": "*",

          // Extra protection against content type trickery.
          "X-Content-Type-Options": "nosniff",
        };
        if (asset.encoding) {
          headers["Content-Encoding"] = asset.encoding;
        }

        res.writeHead(200, headers);
        res.end(asset.content);
      } else {
        res.writeHead(404, {"Content-Type": "text/plain"});
        res.end("not found");
      }
    } else if (req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");

      var url = Url.parse(req.url);
      var purpose = globalDb.fulfillAssetUpload(url.pathname.slice(1));
      if (!purpose) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Upload token not found or expired.");
        return;
      }

      var userId = purpose.profilePicture.userId;
      // TODO(someday): Implement identities, pay attention to identityId.
      check(userId, String);

      var buffers = [];
      var totalSize = 0;
      var done = new Future();
      req.on("data", function (buf) {
        totalSize += buf.length;
        if (totalSize <= (64 * 1024)) {
          buffers.push(buf);
        }
      });
      req.on("end", done.return.bind(done));
      req.on("error", done.throw.bind(done));
      done.wait();

      if (totalSize > (64 * 1024)) {
        // TODO(soon): Resize the image ourselves.
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Picture too large; please use an image under 64 KiB.");
        return;
      }

      var content = Buffer.concat(buffers);
      var type;
      if (checkMagic(content, PNG_MAGIC)) {
        type = "image/png";
      } else if (checkMagic(content, JPEG_MAGIC)) {
        type = "image/jpeg";
      } else {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Image must be PNG or JPEG.");
        return;
      }

      var assetId = globalDb.addStaticAsset({mimeType: type}, content);

      var old = Meteor.users.findAndModify({
        query: {_id: userId},
        update: {$set: {"profile.picture": assetId}},
        fields: {"profile.picture": 1}
      });
      if (old && old.profile && old.profile.picture) {
        globalDb.unrefStaticAsset(old.profile.picture);
      }

      res.writeHead(204, {});
      res.end();
    } else if (req.method === "OPTIONS") {
      var requestedHeaders = req.headers["access-control-request-headers"];
      if (requestedHeaders) {
        res.setHeader("Access-Control-Allow-Headers", requestedHeaders);
      }
      res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Max-Age": "3600"});
      res.end();
    } else {
      res.writeHead(405, "Method Not Allowed", {
        "Allow": "GET, POST, OPTIONS",
        "Content-Type": "text/plain"
      });
      res.end("405 Method Not Allowed: " + req.method);
    }
  }).catch (function (err) {
    writeErrorResponse(res, err);
  });
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

  // BlackrockPayments is only defined in the Blackrock build of Sandstorm.
  if (global.BlackrockPayments) { // Have to check with global, because it could be undefined.
    WebApp.rawConnectHandlers.use(BlackrockPayments.makeConnectHandler(globalDb));
  }

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

      if (id === "static") {
        // Static assets domain.
        serveStaticAsset(req, res);
        return;
      }

      // Try to route the request to a session.
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
            throw new Meteor.Error(404, "No such grain for public ID: " + publicId);
          }
          var grainId = grain._id;

          return staticHandlers[publicId] = wwwHandlerForGrain(grainId);
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
      writeErrorResponse(res, err);
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
        var error = new Error(
            "Error looking up DNS TXT records for host '" + hostname + "': " + err.message);
        error.htmlMessage =
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
          "update it through the respective login provider's management console.</p>";
        error.httpErrorCode = err.code === "ENOTFOUND" ? 404 : 500;
        reject(error);
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
