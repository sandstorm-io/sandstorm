// This file is used by Sandstorm to monkey-patch certain classes/functions in Nodejs
// Specifically, we're changing http.Server.listen to listen on fd=3 instead of the normal
// parameters. This is fine to do globally, since there's only ever one http server in meteor.
var http = require('http');
var net = require('net');

var oldListen = http.Server.prototype._oldListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (port, host, cb) {
  oldListen.call(this, {fd: 3}, cb);
}

require("./main.js");
