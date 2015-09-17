// Typically, Meteor binds to a port and speaks HTTP.
//
// For us, however, `run-bundle` has already bound the port for us as
// FD #3, and we might need to speak HTTPS. So this file runs before
// Meteor starts, monkey-patching the node world so Meteor doesn't
// have to be in on the joke.
//
// Additionally, `run-bundle` may have bound a number of ports that we
// are supposed to run a HTTP redirector service on. This file runs
// those HTTP redirector services.

var http = require('http');
var https = require('https');
var net = require('net');
var fs = require('fs');

function sandstorm_main() {
  // If we need to run a HTTP redirect service, do that first. This way
  // we bind to the ports before we monkey-patch things.
  bindListenerToAlternatePorts();

  // Now monkey-patch things so Meteor's calls to http.Server will do
  // what we need.
  bindListenerToMainPort();

  // Delegate to Meteor.
  require("./main.js");
}

function bindListenerToAlternatePorts() {
  // File descriptors #4, 5, 6, ... are alternate ports that exist for
  // us to serve HTTP redirects on. The redirects send users to the
  // real Sandstorm BASE_URL plus any path component the visitor has
  // supplied.
  //
  // Puprose: If a Sandstorm self-install changes port, it can still
  // listen on the old port and serve up redirects so that old links
  // work.
  function getNumberOfAlternatePorts() {
    var numCommas = (process.env.PORT.match(/,/g) || {}).length;
    var numPorts = numCommas + 1;
    var numAlternatePorts = numPorts - 1;
    return numAlternatePorts;
  };

  for (var i = 0; i < getNumberOfAlternatePorts(); i++) {
    var redirectServer = http.createServer(function (request, response) {
      response.writeHead(302, {"Location": process.env.ROOT_URL + request.url});
      response.end();
    });
    redirectServer.listen({fd: i + 4});
  }
}

function bindListenerToMainPort() {
  // Monkey-patch node so that Meteor can call http.createServer() &
  // listen() and listen on FD #3.
  //
  // Also, optionally, turn http.createServer() into
  // https.createServer() if the Sandstorm install has HTTPS enabled.
  if (process.env.HTTPS_PORT) {
    // HTTPS mode: Monkey-patch http.createServer() to return a https
    // createServer.
    function getHttpsOptions() {
      // TODO: Consider handling HTTPS options other than Sandcats.

      // TODO: Stop hard-coding my laptop's hostname here.
      var basePath = '/var/sandcats/https/laptop.sandcats-dev.sandstorm.io';
      var files = fs.readdirSync(basePath);
      // The key files in this directory are named 0 1 2 3 etc., and
      // metadata about the key is available in e.g. 0.csr. So find the
      // most recent numbered file, then pull metadata out.


      var keyFilesDescending = files.filter(function (filename) {
        return filename.match(/^[0-9]*$/);
      }).sort(function (a, b) {
        return (parseInt(a) < parseInt(b));
      }).reverse();

      var result = {};
      for (var i = 0; i < keyFilesDescending.length; i++) {
        // TODO: Somehow check if the cert is from the future. If so,
        // use a different one.

        var keyFilename = basePath + '/' + keyFilesDescending[i];
        var metadataFilename = keyFilename + '.response-json';
        var metadata = JSON.parse(fs.readFileSync(metadataFilename));

        result['ca'] = metadata['ca'];
        result['key'] = fs.readFileSync(keyFilename, 'utf-8');
        result['cert'] = metadata['cert'];
        return result;
      }
    };

    var fakeHttpCreateServer = function(app) {
      var httpsServer = https.createServer(getHttpsOptions(), app);
      // Meteor calls httpServer.setTimeout() to set a default socket
      // timeout. Since the method is not available on the nodejs
      // v0.10.x https server object, we ignore it entirely for now.
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
    }

    http.createServer = fakeHttpCreateServer;
  }
  else {
    // If no HTTPS, then monkey-patch http.Server to bind to FD #3.
    var oldListen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (port, host, cb) {
      oldListen.call(this, {fd: 3}, cb);
    }
  }
}

sandstorm_main();
