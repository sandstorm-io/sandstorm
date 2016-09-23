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

import Bignum from "bignum";
import { PersistentImpl } from "/imports/server/persistent.js";
const Future = Npm.require("fibers/future");
const Net = Npm.require("net");
const Dgram = Npm.require("dgram");
const Capnp = Npm.require("capnp");

const IpRpc = Capnp.importSystem("sandstorm/ip.capnp");

ByteStreamConnection = class ByteStreamConnection{
  constructor(connection) {
    this.connection = connection;
  }

  done() {
    this.connection.end();
  }

  write(data) {
    this.connection.write(data);
  }

  // expectSize not implemented
  // expectSize(size) { }
};

class IpInterfaceImpl extends PersistentImpl {
  constructor(db, saveTemplate) {
    super(db, saveTemplate);
  }

  listenTcp(portNum, port) {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const server = Net.createServer((connection) => {
        const wrappedConnection = new ByteStreamConnection(connection);
        const upstream = port.connect(wrappedConnection).upstream;

        connection.on("data", (data) => {
          upstream.write(data);
        });

        connection.on("close", (hadError) => {
          upstream.done();
        });

        connection.on("error", (err) => {
          if (resolved) {
            connection.write = errorWrite;
          } else {
            // upstream hasn't been resolved yet, so it's safe to reject
            reject(err);
          }
        });
      });

      server.listen(portNum, () => {
        resolved = true;
        resolve({ handle: server }); // server has a close method which is all we want from a handle
      });

      server.on("error", (err) => {
        if (!resolved) {
          reject(err);
        }
      });
    });
  }

  listenUdp(portNum, port) {
    return new Promise((resolve, reject) => {
      const portMap = {};
      let resolved = false;
      const server = Dgram.createSocket("udp4"); // TODO(someday): handle ipv6 sockets too
      server.bind(portNum);

      server.on("listening", () => {
        // Although UDP is connectionless, we don't resolve until here so that we can handle bind
        // errors such as invalid host
        resolved = true;
        resolve({ handle: server }); // server has a close method which is all we want from a handle
      });

      server.on("error", (err) => {
        // TODO(someday): do something about errors after the promise is resolved
        if (!resolved) {
          reject(err);
        } else {
          console.error("error in listenUdp: " + err);
        }
      });

      const returnMap = {};
      server.on("message", (msg, rinfo) => {
        const address = rinfo.address + "]:" + rinfo.port;
        let returnPort = returnMap[address];

        if (!returnPort) {
          returnMap[address] = returnPort = new BoundUdpPortImpl(server, rinfo.address, rinfo.port);
        }

        port.send(msg, returnPort);
      });
    });
  }
};

// TODO(cleanup): Meteor.startup() needed because 00-startup.js runs *after* code in subdirectories
//   (ugh).
Meteor.startup(() => {
  globalFrontendRefRegistry.register({
    frontendRefField: "ipInterface",
    typeId: IpRpc.IpInterface.typeId,

    restore(db, saveTemplate) {
      return new Capnp.Capability(new IpInterfaceImpl(db, saveTemplate),
                                  IpRpc.PersistentIpInterface);
    },

    validate(db, session, value) {
      check(value, true);

      if (!session.userId) {
        throw new Meteor.Error(403, "Not logged in.");
      }

      return {
        descriptor: { tags: [{ id: IpRpc.IpInterface.typeId }] },
        requirements: [{ userIsAdmin: session.userId }],
        frontendRef: value,
      };
    },

    query(db, userId, value) {
      if (userId && Meteor.users.findOne(userId).isAdmin) {
        return [
          {
            _id: "frontendref-ipinterface",
            frontendRef: { ipInterface: true },
            cardTemplate: "ipInterfacePowerboxCard",
          },
        ];
      } else {
        return [];
      }
    },
  });
});

BoundUdpPortImpl = class BoundUdpPortImpl {
  constructor(server, address, port) {
    this.server = server;
    this.address = address;
    this.port = port;
  }

  send(message, returnPort) {
    // TODO(someday): this whole class is a hack to deal with the fact that we can't compare
    // capabilities or build a map with them. What we should be doing is mapping all ports to
    // their raw physical address/port, and using that here
    this.server.send(message, 0, message.length, this.port, this.address);
  }
};

const bits16 = Bignum(1).shiftLeft(16).sub(1);
const bits32 = Bignum(1).shiftLeft(32).sub(1);

const intToIpv4 = (num) => {
  const part1 = num & 255;
  const part2 = ((num >> 8) & 255);
  const part3 = ((num >> 16) & 255);
  const part4 = ((num >> 24) & 255);

  return part4 + "." + part3 + "." + part2 + "." + part1;
};

const addressToString = (address) => {
  const ipv6num = Bignum(address.upper64).shiftLeft(64).add(Bignum(address.lower64));

  if (ipv6num.shiftRight(32).eq(bits16)) {
    // this is an ipv4 address, we should return it as such
    const ipv4num = ipv6num.and(bits32).toNumber();
    return intToIpv4(ipv4num);
  }

  const hex = ipv6num.toString(16);
  let numColons = 0;
  let out = "";

  for (let i = 0; i < hex.length; ++i) {
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

const addressType = (address) => {
  let type = "udp4";

  // Check if it's an ipv6 address
  // TODO(someday): make this less hacky and change address to explicitly pass this information
  if (address.indexOf(":") != -1) {
    type = "udp6";
  }

  return type;
};

class IpNetworkImpl extends PersistentImpl {
  constructor(db, saveTemplate) {
    super(db, saveTemplate);
  }

  getRemoteHost(address) {
    return { host: new IpRemoteHostImpl(address) };
  }

  getRemoteHostByName(address) {
    return { host: new IpRemoteHostImpl(address) };
  }
};

// TODO(cleanup): Meteor.startup() needed because 00-startup.js runs *after* code in subdirectories
//   (ugh).
Meteor.startup(() => {
  globalFrontendRefRegistry.register({
    frontendRefField: "ipNetwork",
    typeId: IpRpc.IpNetwork.typeId,

    restore(db, saveTemplate) {
      return new Capnp.Capability(new IpNetworkImpl(db, saveTemplate),
                                  IpRpc.PersistentIpNetwork);
    },

    validate(db, session, value) {
      check(value, true);

      if (!session.userId) {
        throw new Meteor.Error(403, "Not logged in.");
      }

      return {
        descriptor: { tags: [{ id: IpRpc.IpNetwork.typeId }] },
        requirements: [{ userIsAdmin: session.userId }],
        frontendRef: value,
      };
    },

    query(db, userId, value) {
      if (userId && Meteor.users.findOne(userId).isAdmin) {
        return [
          {
            _id: "frontendref-ipnetwork",
            frontendRef: { ipNetwork: true },
            cardTemplate: "ipNetworkPowerboxCard",
          },
        ];
      } else {
        return [];
      }
    },
  });
});

IpRemoteHostImpl = class IpRemoteHostImpl {
  constructor(address) {
    if (address.upper64 || address.upper64 === 0) {
      // address is an ip.capnp:IpAddress, we need to convert it
      this.address = addressToString(address);
    } else {
      this.address = address;
    }
  }

  getTcpPort(portNum) {
    return { port: new TcpPortImpl(this.address, portNum) };
  }

  getUdpPort(portNum) {
    return { port: new UdpPortImpl(this.address, portNum) };
  }
};

TcpPortImpl = class TcpPortImpl {
  constructor(address, portNum) {
    this.address = address;
    this.port = portNum;
  }

  connect(downstream) {
    const _this = this;
    let resolved = false;
    return new Promise((resolve, reject) => {
      const client = Net.connect({ host: _this.address, port: _this.port }, () => {
        resolved = true;
        resolve({ upstream: new ByteStreamConnection(client) });
      });

      client.on("data", (data) => {
        downstream.write(data);
      });

      client.on("close", (hadError) => {
        downstream.done();
      });

      client.on("error", (err) => {
        if (resolved) {
          client.write = errorWrite;
        } else {
          // upstream hasn't been resolved yet, so it's safe to reject
          reject(err);
        }
      });
    });
  }
};

const errorWrite = (data) => {
  throw new Error("error occurred in connection");
};

UdpPortImpl = class UdpPortImpl {
  constructor(address, portNum) {
    this.address = address;
    this.port = portNum;

    const type = addressType(address);
    this.socket = Dgram.createSocket(type);

    // TODO(someday): close socket after a certain time of inactivity?
    // This may be pointless since grains are killed frequently when not in use anyways

    // Temporary hack. We only expect clients to pass in a single return port, so we'll store it
    // and only send replies here.
    // This will be changed to be correct when equality comparisons are added to capabilities.
    this.returnPort = null;

    const _this = this;
    this.socket.on("message", (msg, rinfo) => {
      if (_this.returnPort) {
        _this.returnPort.send(msg, _this);
      }
    });
  }

  send(message, returnPort) {
    this.returnPort = returnPort;
    this.socket.send(message, 0, message.length, this.port, this.address);

    // TODO(someday): use callback to catch errors and do something with them
  }
};

