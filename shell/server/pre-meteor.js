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

import { inMeteor } from "/imports/server/async-helpers.js";
const Url = Npm.require("url");
const Fs = Npm.require("fs");
const Dns = Npm.require("dns");
const Future = Npm.require("fibers/future");
const Http = Npm.require("http");
const ByteStream = Capnp.importSystem("sandstorm/util.capnp").ByteStream;

const HOSTNAME = Url.parse(process.env.ROOT_URL).hostname;
const DDP_HOSTNAME = process.env.DDP_DEFAULT_CONNECTION_URL &&
    Url.parse(process.env.DDP_DEFAULT_CONNECTION_URL).hostname;

function isSandstormShell(hostname) {
  // Is this hostname mapped to the Sandstorm shell?

  return (hostname === HOSTNAME || (DDP_HOSTNAME && hostname === DDP_HOSTNAME));
}

// We need to use connect. Let's make sure we're using the same version as Meteor's WebApp module
// uses. Fortunately, they let us extract it.
const connect = WebAppInternals.NpmModules.connect.module;

function writeErrorResponse(res, err) {
  let status = 500;
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

const PNG_MAGIC = new Buffer([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const JPEG_MAGIC = new Buffer([0xFF, 0xD8, 0xFF]);

function checkMagic(buf, magic) {
  if (buf.length < magic.length) return false;

  for (let i = 0; i < magic.length; i++) {
    if (buf[i] != magic[i]) return false;
  }

  return true;
}

function serveStaticAsset(req, res, hostId) {
  inMeteor(() => {
    if (req.method === "GET") {
      const assetCspHeader = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
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

      const url = Url.parse(req.url, true);
      const pathname = url.pathname.slice(1);
      let asset;
      if (pathname.startsWith("identicon/")) {
        const size = parseInt((url.query || {}).s);
        asset = new Identicon(pathname.slice("identicon/".length), size).asAsset();
      } else if (pathname.indexOf("/") == -1) {
        asset = globalDb.getStaticAsset(pathname);
      }

      if (asset) {
        const headers = {
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
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
      }
    } else if (req.method === "POST") {
      res.setHeader("Access-Control-Allow-Origin", "*");

      const url = Url.parse(req.url);
      const purpose = globalDb.fulfillAssetUpload(url.pathname.slice(1));

      // Sanity check the purpose of this upload token.
      if (!purpose) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Upload token not found or expired.");
        return;
      } else if (purpose.profilePicture) {
        const userId = purpose.profilePicture.userId;
        check(userId, String);
      } else if (purpose.loginLogo) {
        // no additional fields for loginLogo
      } else {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Found invalid purpose for upload");
        return;
      }

      const buffers = [];
      let totalSize = 0;
      const done = new Future();
      req.on("data", (buf) => {
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

      const content = Buffer.concat(buffers);
      let type;
      if (checkMagic(content, PNG_MAGIC)) {
        type = "image/png";
      } else if (checkMagic(content, JPEG_MAGIC)) {
        type = "image/jpeg";
      } else {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Image must be PNG or JPEG.");
        return;
      }

      const assetId = globalDb.addStaticAsset({ mimeType: type }, content);

      if (purpose.profilePicture) {
        const accountId = purpose.profilePicture.userId;
        const result = Meteor.users.findAndModify({
          query: { _id: accountId },
          update: { $set: { "profile.picture": assetId } },
          fields: { "profile.picture": 1 },
        });

        if (result.ok) {
          const old = result.value;
          if (old && old.profile && old.profile.picture) {
            globalDb.unrefStaticAsset(old.profile.picture);
          }
        } else {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Couldn't update profile picture.");
          return;
        }
      } else if (purpose.loginLogo) {
        const result = globalDb.collections.settings.findAndModify({
          query: { _id: "whitelabelCustomLogoAssetId" },
          update: {
            $setOnInsert: { _id: "whitelabelCustomLogoAssetId" },
            $set: { value: assetId },
          },
          upsert: true,
          fields: { value: 1 },
        });

        if (result.ok) {
          const old = result.value;
          if (old && old.value) {
            globalDb.unrefStaticAsset(old.value);
          }
        } else {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Couldn't update login logo.");
          return;
        }
      }

      res.writeHead(204, {});
      res.end();
    } else if (req.method === "OPTIONS") {
      const requestedHeaders = req.headers["access-control-request-headers"];
      if (requestedHeaders) {
        res.setHeader("Access-Control-Allow-Headers", requestedHeaders);
      }

      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Max-Age": "3600",
      });
      res.end();
    } else {
      res.writeHead(405, "Method Not Allowed", {
        "Allow": "GET, POST, OPTIONS",
        "Content-Type": "text/plain",
      });
      res.end("405 Method Not Allowed: " + req.method);
    }
  }).catch((err) => {
    writeErrorResponse(res, err);
  });
}

const handleNonMeteorRequest = (req, res, next) => {
  // See if the request was for a host in the wildcard.
  const id = matchWildcardHost(req.headers.host);
  if (id) {
    // Match!
    if (id === "static") {
      // Static assets domain.
      serveStaticAsset(req, res);
      return;
    }
  }

  next();
};

Meteor.startup(() => {
  const meteorRequestListeners = WebApp.httpServer.listeners("request");

  // Construct the middleware chain for requests to non-DDP, non-shell hosts.
  const nonMeteorRequestHandler = connect();
  // BlackrockPayments is only defined in the Blackrock build of Sandstorm.
  if (global.BlackrockPayments) { // Have to check with global, because it could be undefined.
    nonMeteorRequestHandler.use(BlackrockPayments.makeConnectHandler(globalDb));
  }

  nonMeteorRequestHandler.use(handleNonMeteorRequest);

  WebApp.httpServer.removeAllListeners("request");
  WebApp.httpServer.on("request", (req, res) => {
    Promise.resolve(undefined).then(() => {
      if (!req.headers.host) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing Host header");
        return;
      }

      const hostname = req.headers.host.split(":")[0]; // strip port if it exists
      if (isSandstormShell(hostname)) {
        if (req.url.startsWith("/_oauth/")) {
          // Intercept oauth callbacks on the main host to check if the user was actually logging
          // into a standalone host, in which case we need to redirect to that host instead.
          const parsedUrl = Url.parse(req.url, true);
          if (parsedUrl.query && parsedUrl.query.state) {
            const rawState = new Buffer(parsedUrl.query.state, "base64");
            const state = JSON.parse(rawState.toString());
            if (state.redirectUrl) {
              const parsedRedirect = Url.parse(state.redirectUrl);
              const redirectHostname = parsedRedirect.hostname;
              if (redirectHostname !== HOSTNAME) {
                return inMeteor(function () {
                  if (globalDb.hostIsStandalone(redirectHostname)) {
                    res.writeHead(302, { "Location": parsedRedirect.protocol + "//" +
                      parsedRedirect.host + req.url, });
                    res.end();
                    return;
                  } else {
                    throw new Meteor.Error(400, "redirectUrl in OAuth was for an unknown host: " +
                      state.redirectUrl);
                  }
                });
              }
            }
          }
        }
        // If destined for the DDP host or the main host, pass on to Meteor
        for (let i = 0; i < meteorRequestListeners.length; i++) {
          meteorRequestListeners[i](req, res);
        }
      } else {
        return inMeteor(function () {
          if (globalDb.hostIsStandalone(hostname)) {
            // If it's a standalone host, also pass on to meteor
            for (let i = 0; i < meteorRequestListeners.length; i++) {
              meteorRequestListeners[i](req, res);
            }
          } else {
            // Otherwise, dispatch to our own middleware proxy chain.
            nonMeteorRequestHandler(req, res);
            // Adjust timeouts on proxied requests to allow apps to long-poll if needed.
            WebApp._timeoutAdjustmentRequestCallback(req, res);
          }
        });
      }
    }).catch(function (e) {
      // This should never be reached, because all the request handlers should be catching
      // exceptions, but you can never be too careful in a top-level request handler.
      console.error("Unhandled exception in request handler:", e.stack);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Unhandled exception: " + e.stack);
    });
  });
});
