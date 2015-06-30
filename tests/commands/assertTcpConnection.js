var util = require("util");
var events = require("events");
var net = require("net");

function AssertTcpConnection() {
  events.EventEmitter.call(this);
}

util.inherits(AssertTcpConnection, events.EventEmitter);

AssertTcpConnection.prototype.command = function(port, expectedMessage, timeout, cb) {
  var self = this;
  if (timeout instanceof Function) {
    cb = timeout;
    timeout = undefined;
  }
  timeout = timeout || 10000;

  var sock = net.createConnection({port: port});
  sock.setTimeout(timeout, function() {
    console.log("assertTcpConnection timed out.");
    sock.destroy();
    // if we have a callback, call it right before the complete event
    if (cb) {
      cb.call(self.client.api, new Error("Timed out while trying to receive data from tcp socket"));
    } else {
      self.client.api.assert.equal("Timed out while waiting to receive data from tcp socket", "");
    }

    self.emit("complete");
  });

  var buffers = [];
  sock.on("data", function (data) {
    buffers.push(data);
  });
  sock.on("end", function () {
    self.client.api.assert.equal(expectedMessage, Buffer.concat(buffers).toString());
    if (cb) {
      cb.call(self.client.api);
    }
    self.emit("complete");
  });
  sock.on("error", function (err) {
    if (cb) {
      cb.call(self.client.api, err);
    } else {
      self.client.api.assert.equal(err, "");
    }
    self.emit("complete");
  });

  return this;
};

module.exports = AssertTcpConnection;
