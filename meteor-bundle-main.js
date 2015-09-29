// Typically, Meteor binds to one port and speaks HTTP.
//
// For Sandstorm, `run-bundle` has already bound a number of TCP ports
// for us and passed them in as file descriptors starting at #3. So
// this file runs before Meteor starts, monkey-patching the node world
// so that, along with pre-meteor.js, we create the the right
// HTTP+HTTPS services.

// Import modules provided by nodejs core.
var crypto = require('crypto');
var fs = require('fs');
var http = require('http');
var https = require('https');
var net = require('net');
var url = require('url');

// Borrow the "node-forge" dependency of our meteor-node-forge package.
var forge = require('./programs/server/npm/meteor-node-forge/node_modules/node-forge');

function sandstormMain() {
  monkeypatchHttpAndHttps();

  // Delegate to Meteor.
  require("./main.js");
}

function monkeypatchHttpAndHttps() {
  // Two very different monkey-patchings here.
  //
  // 1. Monkey-patch HTTP in the smallest way -- if someone calls
  // listen() but doesn't provide an FD, assume they are Meteor and
  // they want to bind to FD #3.
  var oldListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (port, host, cb) {
    // Overridable by passing e.g. {fd: 4} as port.
    if (typeof port == 'object') {
      return oldListen.call(this, port, host, cb);
    }
    return oldListen.call(this, {fd: 3}, cb);
  }

  // 2. If we are in HTTPS mode, monkey-patch HTTP in a large way:
  // return a HTTPS server, not a HTTP server, so that Meteor gets a
  // HTTPS server on FD #3 without Meteor being aware of the
  // complexity.

  // Stash the original function in createServerForSandstorm(), since
  // in pre-meteor.js we sometimes need to bind HTTP sockets.
  http.createServerForSandstorm = http.createServer;
  var fakeHttpCreateServer = function(requestListener) {
    function makeHttpsDir(hostname) {
      var httpsBasePath = '/var/sandcats/https';
      if (! fs.existsSync(httpsBasePath)) {
        fs.mkdirSync(httpsBasePath, 0700);
      }
      var hostnameDir = httpsBasePath + '/' + hostname;
      if (! fs.existsSync(hostnameDir)) {
        fs.mkdirSync(hostnameDir, 0700);
      }
      return hostnameDir;
    };

    function getNonSniKey() {
      // Call this function to get a 'ca', 'cert', 'key' for browsers
      // that don't support a HTTPS feature called Server Name
      // Indication ("SNI").

      // If we're lucky, we already have the files.
      var hostname = 'client-does-not-support-sni.sandstorm-requires-sni.invalid';
      var basePath = makeHttpsDir(hostname);
      var keyBasename = "0.key";
      var certBasename = "0.crt";
      var keyFilename = basePath + "/" + keyBasename;
      var certFilename = basePath + "/" + certBasename;
      var files = fs.readdirSync(basePath);
      if ((files.indexOf(keyBasename) == -1) ||
          (files.indexOf(certBasename) == -1)) {
        // Generate them synchronously. This could slow down the first
        // start of a HTTPS-enabled Sandstorm.
        console.log("Generating default HTTPS key for use with non-SNI clients. Expect a 45 second delay.");

        // Generate 2048-bit key.
        var keys = forge.pki.rsa.generateKeyPair({bits: 2048});
        var keyAsText = forge.pki.privateKeyToPem(keys.privateKey);
        fs.writeFileSync(keyFilename, keyAsText, "utf-8");

        // Generate certificate.
        var cert = forge.pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = '01';
        cert.validity.notBefore = new Date("2015-09-01T00:00:00Z");
        cert.validity.notAfter = new Date("2025-09-01T00:00:00Z");
        var attribs = [{
          name: 'commonName',
          value: hostname
        }];
        cert.setSubject(attribs);
        cert.setIssuer(attribs);

        // Sign it with the same key.
        cert.sign(keys.privateKey);

        // Save it to disk.
        var certAsText = forge.pki.certificateToPem(cert);
        fs.writeFileSync(certFilename, certAsText, "utf-8");
        console.log("Non-SNI key generation done.");
      }

      var keyAsText = fs.readFileSync(keyFilename, "utf-8");
      var certAsText = fs.readFileSync(certFilename, "utf-8");
      return {
        ca: [],
        key: keyAsText,
        cert: certAsText
      };
    };

    function getCurrentSandcatsKeyAndNextRekeyTime() {
      // Call this function to get up-to-date sandcats https key
      // information.
      //
      // This returns an object with keys [ca, key, cert] which are
      // valid options for https.createServer(). The object we return
      // has one additional key, nextRekeyTime, which is a JS
      // timestamp (UNIX time * 1000) of when the next key becomes
      // valid.
      //
      // The intended use-case is that someone else will check the time
      // and if the time is greater than nextRekeyTime, then call this
      // function again.
      //
      // If nextRekeyTime is null, it means we have only one key.
      var basePath = makeHttpsDir(url.parse(process.env.ROOT_URL).hostname);
      var files = fs.readdirSync(basePath);
      // The key files in this directory are named 0 1 2 3 etc., and
      // metadata about the key is available in e.g. 0.csr. So find
      // the most recent numbered file, then pull metadata out.
      var reverseIntComparator = function (a, b) {
        return (parseInt(b) - parseInt(a));
      };
      var keyFilesDescending = files.filter(function (filename) {
        return filename.match(/^[0-9]*$/);
      }).sort(reverseIntComparator);

      // We might have lots and lots of valid certificates. We're
      // interested in finding the oldest one that is still valid,
      // because we'll actually use that one.
      //
      // "oldest" here means "lowest notBefore" value.
      //
      // The second-best certificate would be a certificate with the
      // second-lowest notBefore that is also still valid.
      //
      // We use the second-best certificate to calculate when to
      // re-key.
      var validCertificates = [];

      // We need the current time to make sure we don't pick a
      // certificate that is expired (now > notAfter).
      var now = new Date().getTime();

      for (var i = 0; i < keyFilesDescending.length; i++) {
        var keyFilename = basePath + '/' + keyFilesDescending[i];
        var metadataFilename = keyFilename + '.response-json';
        try {
          var metadata = JSON.parse(fs.readFileSync(metadataFilename));
          var validity = forge.pki.certificateFromPem(metadata['cert']).validity;
          metadata.notBefore = Date.parse(validity.notBefore);
          metadata.notAfter = Date.parse(validity.notAfter);
          // Store this so we can log it.
          metadata.keyFilename = keyFilename;
        } catch (e) {
          // Ignore EACCESS: The key metadata may have bad permissions
          // due to an installer bug that went out during September.
          //
          // Ignore ENOENT: If we created a key+csr but the server
          // hasn't given us a signed certificate yet, the response-json
          // won't exist.
          if ((e.code === 'EACCES') || (e.code == 'ENOENT')) {
            console.log("Skipping unreadable HTTPS key information file while examining:",
                        metadataFilename);
            continue;
          } else {
            // Sometimes the server gives us a 0-byte response,
            // presumably due to a connection getting reset?.
            console.error("Got exception reading JSON from file:", metadataFilename,
                          "Dazed and confused, but trying to continue.", e);
            continue;
          }
        }

        // If the cert is expired, definitely don't use it.
        if (now > metadata.notAfter) {
          console.log("Skipping", keyFilename, "because", metadata.notAfter, "is in the past.");
          continue;
        }

        validCertificates.push(metadata);
      }

      // Sort by notBefore, ascending.
      validCertificates.sort(function(cert1, cert2) {
        return (cert1.notBefore - cert2.notBefore);
      });

      if (! validCertificates.length) {
        console.error("HTTPS mode is enabled but no certs found.");
        return {nextRekeyTime: null};
      }

      console.log("Using this HTTPS key:", validCertificates[0].keyFilename,
                  "valid starting", new Date(validCertificates[0].notBefore),
                  "until", new Date(validCertificates[0].notAfter));

      // Store HTTPS configuration data from the oldest certificate.
      var result = {
        ca: validCertificates[0].ca,
        key: fs.readFileSync(validCertificates[0].keyFilename, 'utf-8'),
        cert: validCertificates[0].cert,
        notAfter: validCertificates[0].notAfter
      };

      // Calculate re-key time.
      //
      // - If the cert we want to switch to is not valid yet, then we
      //   re-key at its notBefore time.
      //
      // - If the cert we want to switch to *is* already valid, then
      //   we re-key at the notAfter time of our current cert.
      //
      // - If there is no cert we want to switch to, then the
      //   nextRekeyTime is null.
      result.nextRekeyTime = null;

      if (validCertificates.length >= 2) {
        var secondBest = validCertificates[1];
        if (now < secondBest.notBefore) {
          result.nextRekeyTime = secondBest.notBefore;
        } else {
          result.nextRekeyTime = validCertificates[0].notAfter;
        }

        console.log("Will switch to", validCertificates[1].keyFilename,
                    "at time", new Date(result.nextRekeyTime),
                    "via real-time SNI re-keying system.");
      } else {
        console.log("We have only the one key that we know about. We'll need to renew soon.");
      }

      return result;
    };

    if (process.env.HTTPS_PORT) {
      // Great! FD #3 will speak HTTPS.
      //
      // NOTE: This assumes that the user will only set HTTPS_PORT if
      // there are valid certificates for us to use. This could be a
      // problem if BASE_URL is https but we aren't ready.

      // Create a local variable with key information.
      var sandcatsState = {};

      // Create a global that others can call into if they want to
      // re-key, such as when `sandcats.js` downloads a new
      // certificate.
      global.sandcats = {};
      global.sandcats.rekey = function () {
        sandcatsState = getCurrentSandcatsKeyAndNextRekeyTime();
      };
      global.sandcats.shouldGetAnotherCertificate = function() {
        // Get a new certificate if our current cert (a) does not
        // exist, or (b) has fewer than three days left.
        if (! sandcatsState.key) {
          console.log("shouldGetAnotherCertificate: There is no key, so yes get a new one.");
          return true;
        }

        var threeDaysInMilliseconds = 1000 * 60 * 60 * 24 * 3;
        var now = new Date();
        var expiry = sandcatsState.notAfter;
        var timeLeft = expiry - now.getTime();

        if (timeLeft < threeDaysInMilliseconds) {
          return true;
        } else {
          console.log("Since", now, "is more than three days away from",
                      new Date(expiry), "not renewing HTTPS cert yet.");
        }
      }

      // Set up initial keys. We do this directly, skipping the
      // rekey() machinery, since rekey() wants to restart the process
      // sometimes, and we never want that on initial startup.
      sandcatsState = getCurrentSandcatsKeyAndNextRekeyTime();

      // Configure options for httpsServer.createServer().
      var httpsOptions = getNonSniKey();

      // The SNICallback option is a function that nodejs will call on
      // every inbound request with the inbound hostname. We get to
      // return an object of ca & key & cert to use.
      //
      // This gives us an opportunity to fetch the latest key
      // information from the filesystem, allowing for smooth,
      // zero-downtime, https service re-keying. Note that the
      // automatic re-keying only works for clients that support the
      // HTTPS feature called Server Name Indication. Per
      // http://caniuse.com/#feat=sni SNI is very popular.
      httpsOptions.SNICallback = function(servername) {
        var certAtStart = sandcatsState.cert;

        var jsTimeNow = new Date().getTime();

        if ((sandcatsState.nextRekeyTime !== null) &&
            (jsTimeNow >= sandcatsState.nextRekeyTime)) {
          console.log("Since", jsTimeNow, "is greater than", sandcatsState.nextRekeyTime,
                      "doing a https re-key.");
          global.sandcats.rekey();

          if (certAtStart == sandcatsState.cert) {
            console.log("Re-keying resulted in the same certificate. Strange.");
          } else {
            console.log("Re-keying resulting in a new certificate. Good.");
          }
        }

        return crypto.createCredentials({
          ca: sandcatsState.ca,
          key: sandcatsState.key,
          cert: sandcatsState.cert
        }).context;
      };
      var httpsServer = https.createServer(httpsOptions, requestListener);

      // Meteor calls httpServer.setTimeout() to set a default socket
      // timeout. Since the method is not available on the nodejs
      // v0.10.x https server object, we ignore it entirely for now.
      //
      // TODO(security): Run slowloris against this to make sure it is
      // safe to ignore.
      //
      // Note that upon actually receiving a connection, Meteor
      // adjusts the timeouts, so setTimeout only the socket before
      // the HTTP message got parsed.
      httpsServer.setTimeout = function() {};

      // When Meteor calls .listen() we bind to FD #3 and speak HTTPS.
      var oldListen = https.Server.prototype.listen;
      httpsServer.listen = function (port, host, cb) {
        var server = this;
        // If we have a key ready, then we listen
        // immediately. Otherwise retry loop.
        var listenIfKey = function() {
          var shouldListen = !! sandcatsState.key;
          if (shouldListen) {
            oldListen.call(server, {fd: 3}, cb);
          }
          return shouldListen;
        };
        var attemptToListen = function() {
          if (! listenIfKey()) {
            console.log("No key, so can't listen for HTTPS yet. Will retry in three seconds.");
            setTimeout(attemptToListen, 3000);
          }
        }
        attemptToListen();
      }
      return httpsServer;
    } else {
      // Call http.createServerForSandstorm(), knowing that .listen()
      // has been monkey-patched separately.
      return http.createServerForSandstorm(requestListener);
    }
  }

  http.createServer = fakeHttpCreateServer;
}

sandstormMain();
