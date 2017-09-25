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

var isDevShellMode = process.argv.length > 2;

var firstInheritedFd = isDevShellMode ? 65 : 3;

// Use the "node-forge" package from npm
var forge = isDevShellMode
    ? require('./shell/node_modules/node-forge')
    : require('./programs/server/npm/node_modules/node-forge');

function sandstormMain() {
  if (process.env.EXPERIMENTAL_GATEWAY) {
    process.env.SANDSTORM_SMTP_LISTEN_HANDLE = (firstInheritedFd + 2).toString();
    process.env.SANDSTORM_BACKEND_HANDLE = (firstInheritedFd + 1).toString();
    monkeypatchHttpForGateway();
  } else {
    process.env.SANDSTORM_SMTP_LISTEN_HANDLE = firstInheritedFd.toString();
    monkeypatchHttpAndHttps();
  }

  if (isDevShellMode) {
    // Cut ourselves out of argv.
    process.argv = [process.argv[0]].concat(process.argv.slice(2));

    // Change to the shell directory, which Meteor expects.
    process.chdir("shell");

    // Delegate to Meteor dev tool.
    require(process.argv[1]);
  } else {
    // Delegate to Meteor runtime.
    require("./main.js");
  }
}

function monkeypatchHttpForGateway() {
  // Monkey-patch the HTTP server module to receive connections over a unix socket on FD 3 instead
  // of listening the usual way.

  // Node.js has no public API for receiving file descriptors via SCM_RIGHTS on a unix pipe.
  // However, it does have a *private* API for this, which it uses to implement child_process.
  // We use the private API here. This could break when we update Node. If so, that's our fault.
  // But we pin our Node version, so this should be easy to control. Also, this interface hasn't
  // changed in forever.
  var Pipe = process.binding('pipe_wrap').Pipe;

  var oldListen = http.Server.prototype.listen;
  var alreadyListened = false;
  http.Server.prototype.listen = function (port, host, cb) {
    if (port.toString() === process.env.PORT) {
      // Attempt to listen on the HTTP port. Override.
      if (alreadyListened) {
        throw new Error("can only listen on primary HTTP port once");
      }
      alreadyListened = true;

      var pipe = new Pipe(true);
      var httpServer = this;
      pipe.open(firstInheritedFd);
      pipe.onread = function (size, buf, handle) {
        if (handle) {
          httpServer.emit("connection", new net.Socket({ handle: handle }));
        }
      };
      pipe.readStart();
      cb();
    } else {
      // Don't override.
      return oldListen.call(this, port, host, cb);
    }
  }
}

function monkeypatchHttpAndHttps() {
  // Two very different monkey-patchings here.
  //
  // 1. Monkey-patch HTTP in the smallest way -- if someone calls
  // listen() but doesn't provide an FD, assume they are Meteor and
  // they want to bind to FD #4.
  var oldListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (port, host, cb) {
    // Overridable by passing e.g. {fd: 5} as port.
    if (typeof port == 'object' && port.fd) {
      return oldListen.call(this, port, host, cb);
    }
    return oldListen.call(this, {fd: firstInheritedFd + 1}, cb);
  }

  // 2. If we are in HTTPS mode, monkey-patch HTTP in a large way:
  // return a HTTPS server, not a HTTP server, so that Meteor gets a
  // HTTPS server on FD #4 without Meteor being aware of the
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

    function getBestCertificate(now, files, basePath, preferOldest) {
      // Get the newest certificate from disk, using "now" as a
      // reference time by which to judge if a certificate is valid
      // yet.
      var validCertificates = [];
      for (var i = 0; i < files.length; i++) {
        var keyFilename = basePath + '/' + files[i];
        var metadataFilename = keyFilename + '.response-json';
        try {
          var metadata = JSON.parse(fs.readFileSync(metadataFilename));

          if (metadata.ca && metadata.ca.length === 2) {
            // Our metadata files contain a field `ca` which contains the CA certificate and
            // intermediate certificate. However, Node doesn't want this field; it wants the server
            // certificate followed by the intermediate concatenated as one text blob. Qualys
            // complains if we send the root cert since it's not useful -- the user needs to have
            // it in their trust store anyway. ca[1] is always the intermediate cert, whereas ca[0]
            // is the root.
            // TODO(cleanup): Adjust the Sandcats server so that it doesn't send the `ca` field at
            //   all. This branch will then turn itself off.
            metadata.cert = [metadata.cert, metadata.ca[1]].join("\r\n");
            delete metadata.ca;
          }

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

      // Sort by notBefore, descending (freshest first).
      validCertificates.sort(function(cert1, cert2) {
        return (cert2.notBefore - cert1.notBefore);
      });

      // If we prefer oldest, reverse that.
      if (preferOldest) {
        validCertificates = validCertificates.reverse();
      }

      return validCertificates[0];
    }

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
      // The key files in this directory are named 0 1 2 3 etc, but we
      // ignore their filenames.
      var files = fs.readdirSync(basePath);

      // We might have lots and lots of valid certificates. We're
      // interested in finding:
      //
      // - A "reference" certificate, which is the _newest_
      //   certificate that is currently valid. Newest is defined as
      //   the greatest NotBefore value.
      //
      // - If the "reference" certificate only started being valid in
      //   the past 20 minutes, then try to find a "temporary"
      //   certificate to use in that time, and schedule a re-key for
      //   when the "reference" certificate is worth using.
      //
      // - We should do all "Should we renew?" calculations based on
      //   the reference certificate, even if we aren't actually using
      //   it yet.
      //
      // We avoid using a cert so fresh as the past 20 minutes so that
      // GlobalSign has some time to update OCSP.
      var now = new Date().getTime();
      var twentyMinutesAgo = now - (1000 * 60 * 20);
      var referenceCertificate = getBestCertificate(now, files, basePath, false);

      if (! referenceCertificate) {
        console.error("HTTPS mode is enabled but no certs found.");
        return {nextRekeyTime: null};
      }

      // By default, we will use the reference certificate immediately.
      var useThisCertificate = referenceCertificate;

      // We know that now > referenceCertificate.notBefore because it was
      // returned to us.
      //
      // Has it been valid for the past 20 minutes? Meaning, is
      // twentyMinutesAgo > referenceCertificate.notBefore? If it is,
      // then great, let's definitely use the reference
      // certificate. If not, then let's try to find a different cert.
      if (twentyMinutesAgo > referenceCertificate.notBefore) {
        // Great!
      } else {
        console.log("Looks like",
                    new Date(referenceCertificate.notBefore),
                    "started being fresh in the last 20 min, i.e. before",
                    new Date(twentyMinutesAgo));
        // Look for the oldest cert we can. Maybe it'll be the same,
        // maybe not, but at least we tried.
        //
        // This is useful if a Sandstorm restart occurs at an
        // inopportune time, causing us to accidentally re-key.
        var maybeUseThisCertificateInstead = getBestCertificate(now, files, basePath, true);
        if (maybeUseThisCertificateInstead.keyFilename != referenceCertificate.keyFilename) {
          useThisCertificate = maybeUseThisCertificateInstead;
        }
      }

      console.log("Certificate we want to use:", referenceCertificate.keyFilename,
                  "valid starting", new Date(referenceCertificate.notBefore),
                  "until", new Date(referenceCertificate.notAfter));

      if (useThisCertificate.keyFilename != referenceCertificate.keyFilename) {
        console.log("Going to use this one for a little while first:",
                    useThisCertificate.keyFilename,
                    "valid starting", new Date(useThisCertificate.notBefore),
                    "until", new Date(useThisCertificate.notAfter));
      }

      // Store HTTPS configuration data from the cert we want to use.
      //
      // Also store bestCertExpiryTime (only looked-at within this
      // file) based on the reference cert, even if we're not using it
      // yet.
      var result = {
        ca: useThisCertificate.ca,
        key: fs.readFileSync(useThisCertificate.keyFilename, 'utf-8'),
        cert: useThisCertificate.cert,
        notAfter: useThisCertificate.notAfter,
        bestCertExpiryTime: referenceCertificate.notAfter
      };

      // Calculate re-key time.
      //
      // - If we're not using the reference certificate yet, then we
      //   should switch to it at the soonest of (20 min from now) and
      //   when the current cert expires (minus 20 min to avoid clock
      //   skew).
      //
      // - Otherwise, we know nothing about when to re-key, and we
      //   just sit here waiting for `sandcats.js` to download a new
      //   key for us to use, at which point we will either switch to
      //   it immediately or do the reference-cert-wait-20-min dance.
      result.nextRekeyTime = null;

      if (useThisCertificate.keyFilename != referenceCertificate.keyFilename) {
        var twentyMinutesInMilliseconds = 1000 * 60 * 20;
        var twentyMinutesFromNow = now + twentyMinutesInMilliseconds;
        var notAfterMinusTwentyMinutes = result.notAfter - twentyMinutesInMilliseconds;

        // But never attempt to re-key in the past...
        if (notAfterMinusTwentyMinutes < now) {
          notAfterMinusTwentyMinutes = result.notAfter;
        }

        result.nextRekeyTime = Math.min(
          notAfterMinusTwentyMinutes, twentyMinutesFromNow);

        console.log("Will switch certs, probably to", referenceCertificate.keyFilename,
                    ", at time", new Date(result.nextRekeyTime),
                    "via real-time SNI re-keying system.");
      } else {
        console.log("We have only the one key that we know about. We'll need to renew soon.");
      }

      return result;
    };

    if (process.env.HTTPS_PORT) {
      // Great! FD #4 will speak HTTPS.
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
        var expiry = sandcatsState.bestCertExpiryTime;
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

      // Set default ciphers & tell HTTPS clients we really like our ciphers.
      //
      // This ciphers list is from the nginx configuration for
      // oasis.sandstorm.io.
      var ciphers = ("ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:DHE-DSS-AES128-GCM-SHA256:kEDH+AESGCM:ECDHE-RSA-AES128-SHA256:ECDHE-ECDSA-AES128-SHA256:ECDHE-RSA-AES128-SHA:ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES256-SHA384:ECDHE-ECDSA-AES256-SHA384:ECDHE-RSA-AES256-SHA:ECDHE-ECDSA-AES256-SHA:DHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA:DHE-DSS-AES128-SHA256:DHE-RSA-AES256-SHA256:DHE-DSS-AES256-SHA:DHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA256:AES256-SHA256:AES128-SHA:AES256-SHA:AES:CAMELLIA:DES-CBC3-SHA:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!aECDH:!EDH-DSS-DES-CBC3-SHA:!EDH-RSA-DES-CBC3-SHA:!KRB5-DES-CBC3-SHA");
      var honorCipherOrder = true;

      httpsOptions.ciphers = ciphers;
      httpsOptions.honorCipherOrder = honorCipherOrder;

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
      httpsOptions.SNICallback = function(servername, callback) {
        try {
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

          callback(null, crypto.createCredentials({
            ciphers: ciphers,
            honorCipherOrder: honorCipherOrder,
            ca: sandcatsState.ca,
            key: sandcatsState.key,
            cert: sandcatsState.cert
          }).context);
        } catch (err) {
          callback(err);
        }
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

      // When Meteor calls .listen() we bind to FD #4 and speak HTTPS.
      var oldListen = https.Server.prototype.listen;
      httpsServer.listen = function (port, host, cb) {
        var server = this;
        // If we have a key ready, then we listen
        // immediately. Otherwise retry loop.
        var listenIfKey = function() {
          var shouldListen = !! sandcatsState.key;
          if (shouldListen) {
            oldListen.call(server, {fd: firstInheritedFd + 1}, cb);
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
