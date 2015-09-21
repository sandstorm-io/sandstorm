// Typically, Meteor binds to one port and speaks HTTP.
//
// For Sandstorm, `run-bundle` has already bound a number of TCP ports
// for us and passed them in as file descriptors starting at #3. So
// this file runs before Meteor starts, monkey-patching the node world
// so that, along with pre-meteor.js, we create the the right
// HTTP+HTTPS services.

var crypto = require('crypto');
var fs = require('fs');
var http = require('http');
var https = require('https');
var net = require('net');
var url = require('url');

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
      // If nextRekeyTime is null, then the caller should not bother
      // calling this function, since it means this function has no
      // knowledge of other keys that will become valid.
      var basePath = '/var/sandcats/https/' + (
        url.parse(process.env.ROOT_URL).hostname);
      var files = fs.readdirSync(basePath);
      // The key files in this directory are named 0 1 2 3 etc., and
      // metadata about the key is available in e.g. 0.csr. So find
      // the most recent numbered file, then pull metadata out.
      var reverseIntComparator = function (a, b) {
        return (parseInt(a) < parseInt(b));
      };
      var keyFilesDescending = files.filter(function (filename) {
        return filename.match(/^[0-9]*$/);
      }).sort(reverseIntComparator);

      var result = {};
      result.nextRekeyTime = null;  // by default, no rekeying.
      var nowUnixTimestamp = new Date().getTime() / 1000;
      for (var i = 0; i < keyFilesDescending.length; i++) {
        var keyFilename = basePath + '/' + keyFilesDescending[i];
        var metadataFilename = keyFilename + '.response-json';
        try {
          var metadata = JSON.parse(fs.readFileSync(metadataFilename));
        } catch (e) {
          // Ignore EACCESS: The key metadata may have bad permissions
          // due to an installer bug that went out during September.
          //
          // Ignore ENOENT: If we created a key+csr but the server
          // hasn't given us a signed certificate yet, the response-json
          // won't exist.
          if ((e.code === 'EACCES') || (e.code == 'ENOENT')) {
            console.log("Skipping unreadable HTTPS key information file:", metadataFilename);
            continue;
          } else {
            throw e;
          }
        }

        // If this certificate isn't valid yet, keep looping, hoping
        // to find one that is valid.
        var notBefore = metadata['notBefore'];
        if (notBefore && (notBefore < nowUnixTimestamp)) {
          // Convert this notBefore into a nextRekeyTime (JS
          // timestamp) and save it as nextRekeyTime.
          //
          // Note that currently we re-key right at the notBefore, so
          // in the case of clock skew, bad things might happen. We
          // could delay the rekey time a little bit if that seems
          // like a problem.
          result.nextRekeyTime = notBefore * 1000;
          continue;
        }

        result['ca'] = metadata['ca'];
        result['key'] = fs.readFileSync(keyFilename, 'utf-8');
        result['cert'] = metadata['cert'];
        return result;
      }
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

      // Actually set up keys!
      global.sandcats.rekey();

      // Configure options for httpsServer.createServer().
      var httpsOptions = {
        ca: sandcatsState.ca,
        key: sandcatsState.key,
        cert: sandcatsState.cert
      };

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
        oldListen.call(this, {fd: 3}, cb);
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
