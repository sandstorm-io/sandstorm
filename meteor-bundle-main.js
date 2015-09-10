// Typically, Meteor binds to one port and speaks HTTP.
//
// For Sandstorm, `run-bundle` has already bound a number of TCP ports
// for us and passed them in as file descriptors starting at #3. So
// this file runs before Meteor starts, monkey-patching the node world
// so that, along with pre-meteor.js, we create the the right
// HTTP+HTTPS services.

var fs = require('fs');
var http = require('http');
var https = require('https');
var net = require('net');
var url = require('url');

function sandstorm_main() {
  monkeypatchHttpAndHttps();

  // Delegate to Meteor.
  require("./main.js");
}

function monkeypatchHttpAndHttps() {
  // Monkey-patch the HTTP object's listen() function so if Meteor
  // calls it, then we listen on FD #3.
  var oldListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (port, host, cb) {
    // Overridable by passing e.g. {fd: 4} as port.
    if (typeof port == 'object') {
      return oldListen.call(this, port, host, cb);
    }
    return oldListen.call(this, {fd: 3}, cb);
  }

  // When Meteor calls createServer(), if we are in HTTPS mode, give it a HTTPS server.
  //
  // Passing a second argument of `true` allows us to call the real
  // createServer directly in pre-meteor.js.
  var originalHttpCreateServer = http.createServer;
  var fakeHttpCreateServer = function(requestListener, calledBySandstorm) {
    if (calledBySandstorm) {
      return originalHttpCreateServer(requestListener);
    }

    function getHttpsOptions() {
      var basePath = '/var/sandcats/https/' + (
        url.parse(process.env.ROOT_URL).hostname);
      var files = fs.readdirSync(basePath);
      // The key files in this directory are named 0 1 2 3 etc., and
      // metadata about the key is available in e.g. 0.csr. So find
      // the most recent numbered file, then pull metadata out.

      var keyFilesDescending = files.filter(function (filename) {
        return filename.match(/^[0-9]*$/);
      }).sort(function (a, b) {
        return (parseInt(a) < parseInt(b));
      }).reverse();

      var result = {};
      var nowUnixTimestamp = new Date() / 1000;
      for (var i = 0; i < keyFilesDescending.length; i++) {
        var keyFilename = basePath + '/' + keyFilesDescending[i];
        var metadataFilename = keyFilename + '.response-json';
        var metadata = JSON.parse(fs.readFileSync(metadataFilename));

        // If this certificate isn't valid yet, keep looping, hoping
        // to find one that is valid.
        var notBefore = metadata['notBefore'];
        if (notBefore && (notBefore < nowUnixTimestamp)) {
          continue;
        }

        result['ca'] = metadata['ca'];
        result['key'] = fs.readFileSync(keyFilename, 'utf-8');
        result['cert'] = metadata['cert'];
        return result;
      }
    };

    if (process.env.HTTPS_PORT) {
      var httpsServer = https.createServer(getHttpsOptions(), requestListener);
      // Meteor calls httpServer.setTimeout() to set a default socket
      // timeout. Since the method is not available on the nodejs
      // v0.10.x https server object, we ignore it entirely for now.
      //
      // TODO(soon): Run slowloris against this to make sure it is
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
      return originalHttpCreateServer(requestListener);
    }
  }

  http.createServer = fakeHttpCreateServer;
}

sandstorm_main();
