
// The debugger pauses here when you run `meteor debug`, because this is
// the very first code to be executed by the server process. If you have
// not already added any `debugger` statements to your code, feel free to
// do so now, wait for the server to restart, then reload this page and
// click the |▶ button to continue.
var http = require('http');
var net = require('net');

var oldListen = http.Server.prototype._oldListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (port, host, cb) {
  oldListen.call(this, {fd: 3}, cb);
}

process.argv.splice(2, 0, 'program.json');
process.chdir(require('path').join(__dirname, 'programs', 'server'));
require('./programs/server/boot.js');
