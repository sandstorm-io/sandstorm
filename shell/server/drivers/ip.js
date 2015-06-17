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

var Future = Npm.require("fibers/future");
var Net = Npm.require("net");
var Dgram = Npm.require("dgram");
var Promise = Npm.require("es6-promise").Promise;
var Capnp = Npm.require("capnp");

var IpRpc = Capnp.importSystem("sandstorm/ip.capnp");

function ByteStreamConnection (connection) {
  this.connection = connection;
}

ByteStreamConnection.prototype.done = function () {
  this.connection.end();
};

ByteStreamConnection.prototype.write = function (data) {
  this.connection.write(data);
};

// expectSize not implemented
// ByteStreamConnection.prototype.expectSize = function (size) { }

IpInterfaceImpl = function (userId) {
  this.userId = userId;
};

IpInterfaceImpl.prototype.save = function (params) {
  return saveFrontendRef({ipInterface: true}, params.sealFor, this.userId);
};

IpInterfaceImpl.prototype.listenTcp = function (portNum, port) {
  return new Promise(function (resolve, reject) {
    var resolved = false;
    var server = Net.createServer(function (connection) {
      var wrappedConnection = new ByteStreamConnection(connection);
      var upstream = port.connect(wrappedConnection).upstream;

      connection.on("data", function (data) {
        upstream.write(data);
      });

      connection.on("close", function (had_error) {
        upstream.done();
      });

      connection.on("error", function (err) {
        if (resolved) {
          connection.write = errorWrite;
        } else {
          // upstream hasn't been resolved yet, so it's safe to reject
          reject(err);
        }
      });
    });

    server.listen(portNum, function () {
      resolved = true;
      resolve({handle: server}); // server has a close method which is all we want from a handle
    });

    server.on("error", function (err) {
      if (!resolved) {
        reject(err);
      }
    });
  });

};

function BoundUdpPortImpl(server, address, port) {
  this.server = server;
  this.address = address;
  this.port = port;
}

BoundUdpPortImpl.prototype.send = function(message, returnPort) {
  // TODO(someday): this whole class is a hack to deal with the fact that we can't compare
  // capabilities or build a map with them. What we should be doing is mapping all ports to
  // their raw physical address/port, and using that here
  this.server.send(message, 0, message.length, this.port, this.address);
};

IpInterfaceImpl.prototype.listenUdp = function (portNum, port) {
  return new Promise(function (resolve, reject) {
    var portMap = {};
    var resolved = false;
    var server = Dgram.createSocket("udp4"); // TODO(someday): handle ipv6 sockets too
    server.bind(portNum);

    server.on("listening", function () {
      // Although UDP is connectionless, we don't resolve until here so that we can handle bind
      // errors such as invalid host
      resolved = true;
      resolve({handle: server}); // server has a close method which is all we want from a handle
    });

    server.on("error", function (err) {
      // TODO(someday): do something about errors after the promise is resolved
      if (!resolved) {
        reject(err);
      } else {
        console.error("error in listenUdp: " + err);
      }
    });

    var returnMap = {};
    server.on("message", function (msg, rinfo) {
      var address = rinfo.address + "]:" + rinfo.port;
      var returnPort = returnMap[address];

      if (!returnPort) {
        returnMap[address] = returnPort = new BoundUdpPortImpl(server, rinfo.address, rinfo.port);
      }
      port.send(msg, returnPort);
    });
  });
};

var bits16 = Bignum(1).shiftLeft(16).sub(1);
var bits32 = Bignum(1).shiftLeft(32).sub(1);

var intToIpv4 = function (num) {
  var part1 = num & 255;
  var part2 = ((num >> 8) & 255);
  var part3 = ((num >> 16) & 255);
  var part4 = ((num >> 24) & 255);

  return part4 + "." + part3 + "." + part2 + "." + part1;
};

var addressToString = function (address) {
  var ipv6num = Bignum(address.upper64).shiftLeft(64).add(Bignum(address.lower64));

  if (ipv6num.shiftRight(32).eq(bits16)) {
    // this is an ipv4 address, we should return it as such
    var ipv4num = ipv6num.and(bits32).toNumber();
    return intToIpv4(ipv4num);
  }
  var hex = ipv6num.toString(16);
  var numColons = 0;
  var out = "";

  for(var i = 0; i < hex.length; ++i) {
    // start with lower bits of address and build the output in reverse
    // this ensures that we can place a colon every 4 characters
    out += hex[hex.length - 1 - i];
    if ((i + 1) % 4 === 0) {
      out += ":";
      ++numColons;
    }
  }

  // Double colon represents all bits being 0
  if (numColons < 7) {
    out += "::";
  }

  return out.split("").reverse().join("");
};

var addressType = function (address) {
  var type = "udp4";
  // Check if it's an ipv6 address
  // TODO(someday): make this less hacky and change address to explicitly pass this information
  if (address.indexOf(":") != -1) {
    type = "udp6";
  }
  return type;
};

IpNetworkImpl = function (userId) {
  this.userId = userId;
};

IpNetworkImpl.prototype.save = function (params) {
  return saveFrontendRef({ipNetwork: true}, params.sealFor, this.userId);
};

IpNetworkImpl.prototype.getRemoteHost = function (address) {
  return {host: new IpRemoteHostImpl(address)};
};

function IpRemoteHostImpl (address) {
  this.address = addressToString(address);
}

IpRemoteHostImpl.prototype.getTcpPort = function (portNum) {
  return {port: new TcpPortImpl(this.address, portNum)};
};

IpRemoteHostImpl.prototype.getUdpPort = function (portNum) {
  return {port: new UdpPortImpl(this.address, portNum)};
};

function TcpPortImpl (address, portNum) {
  this.address = address;
  this.port = portNum;
}

var errorWrite = function (data) {
  throw new Error("error occurred in connection");
};

TcpPortImpl.prototype.connect = function (downstream) {
  var _this = this;
  var resolved = false;
  return new Promise(function (resolve, reject) {
    var client = Net.connect({host: _this.address, port: _this.port}, function () {
      resolved = true;
      resolve({upstream: new ByteStreamConnection(client)});
    });

    client.on("data", function (data) {
      downstream.write(data);
    });

    client.on("close", function (had_error) {
      downstream.done();
    });

    client.on("error", function (err) {
      if (resolved) {
        client.write = errorWrite;
      } else {
        // upstream hasn't been resolved yet, so it's safe to reject
        reject(err);
      }
    });
  });
};

function UdpPortImpl (address, portNum) {
  this.address = address;
  this.port = portNum;

  var type = addressType(address);
  this.socket = Dgram.createSocket(type);
  // TODO(someday): close socket after a certain time of inactivity?
  // This may be pointless since grains are killed frequently when not in use anyways

  // Temporary hack. We only expect clients to pass in a single return port, so we'll store it
  // and only send replies here.
  // This will be changed to be correct when equality comparisons are added to capabilities.
  this.returnPort = null;

  var _this = this;
  this.socket.on("message", function (msg, rinfo) {
    if (_this.returnPort) {
      _this.returnPort.send(msg, _this);
    }
  });
}

UdpPortImpl.prototype.send = function (message, returnPort) {
  this.returnPort = returnPort;
  this.socket.send(message, 0, message.length, this.port, this.address);
  // TODO(someday): use callback to catch errors and do something with them
};
