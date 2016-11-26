# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
# All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

@0xf44732d435305f86;
# This file defines Cap'n Proto interfaces for TCP/IP networking.
#
# The purpose of these interfaces is to implement "driver" applications -- that is, apps which
# themselves implement raw legacy network protocols (e.g. HTTP, SMTP, XMPP, etc.) and then
# re-export those protocols as a Cap'n Proto interface with meaningful separation of capabilities.
# Driver applications generally must be "approved by the Sandstorm adminsitrator" because raw
# network access can be abused in ways that harm the server as a whole. For example, an app which
# secretly sends spam via SMTP or engages in piracy via Bittorrent could harm the server's
# reputation, not just the user's.
#
# In practice, a driver app is technically just a regular application that makes a Powerbox request
# for raw network access (represented by the interfaces defined in this file). Only the server
# administrator normally possesses these capabilities, therefore only the administartor can
# normally authorize such apps.
#
# Of course, a regular user could run a driver app and connect it to fake networking capabilities,
# e.g. for the purpose of testing, or for use over a fake IP network that only connects to other
# Sandstorm apps.
#
# For simplicity in porting legacy apps, sandstorm-http-bridge can optionally be configured to
# act as an IP proxy, allowing legacy apps to transparently use IP networking via the standard
# socket API.

$import "/capnp/c++.capnp".namespace("sandstorm");

using Util = import "util.capnp";
using SystemPersistent = import "supervisor.capnp".SystemPersistent;

interface IpNetwork @0xa982576b7a2a2040 {
  # Capability to connect or send messages to arbitrary destinations on an IP network.
  #
  # A driver app can request this from the Powerbox in order to request "full outbound network
  # access". The IpNetwork capability is a dangerous capability that should only be granted to
  # trusted drivers. Only the Sandstorm server administrator is likely to possess this capability.

  getRemoteHost @0 (address :IpAddress) -> (host :IpRemoteHost);
  # Get the remote host corresponding to the given address.

  getRemoteHostByName @1 (address :Text) -> (host :IpRemoteHost);
  # Like `getRemoteHost()` but parse the address from text and perform a DNS lookup if necessary.
  # Textual representations of IP addresses will also be accepted.
}

struct IpAddress {
  # An IPv6 address.
  #
  # IPv4 addresses must be represented using IPv4-mapped IPv6 addresses.

  lower64 @0 :UInt64;
  upper64 @1 :UInt64;
  # Bits of the IPv6 address. Since IP is a big-endian spec, the "lower" bits are on the right, and
  # the "upper" bits on the left. E.g., if the address is "1:2:3:4:5:6:7:8", then the lower 64 bits
  # are "5:6:7:8" or 0x0005000600070008 while the upper 64 bits are "1:2:3:4" or 0x0001000200030004.
  #
  # Note that for an IPv4 address, according to the standard IPv4-mapped IPv6 address rules, you
  # would use code like this:
  #     uint32 ipv4 = (octet[0] << 24) | (octet[1] << 16) | (octet[2] << 8) | octet[3];
  #     dest.setLower64(0x0000FFFF00000000 | ipv4);
  #     dest.setUpper64(0);
}

interface IpInterface @0xe32c506ee93ed6fa {
  # Capability to accept connections / messages on a particular network interface.
  #
  # In practice this could represent a single physical network interface, a single local IP
  # address, or "all interfaces" (i.e. 0.0.0.0).
  #
  # A driver app can request this from the Powerbox in order to request "full inbound network
  # access", i.e. permission to open and listen on any port. The IpInterface capability is a
  # dangerous capability that should only be granted to trusted drivers. Only the Sandstorm server
  # administrator is likely to possess this capability.

  listenTcp @0 (portNum :UInt16, port :TcpPort) -> (handle :Util.Handle);
  # Binds `port` to the given TCP port number, so that it will receive any incoming TCP connections
  # to the port.

  listenUdp @1 (portNum :UInt16, port :UdpPort) -> (handle :Util.Handle);
  # Binds `port` to the given UDP port number, so that it will receive any incoming UDP datagrams
  # sent to the port.
}

interface IpRemoteHost @0x905dd76b298b3130 {
  # Capability to connect / send messages to a particular remote host accessed over an IP network.
  #
  # A driver app can request this form the Powerbox in order to request "permission to connect to
  # arbitrary ports on a particular host". While not as dangerous as IpNetwork, this is still a
  # sensitive capability, as connecting to e.g. Google could allow an app to send mass quantities
  # of spam (while perhaps claiming that it is just updating your calendar, or something).
  #
  # Only request an `IpRemoteHost` capability if you need to be able to connect to multiple ports
  # on the host. If you only need to connect to one port, request `TcpPort` or `UdpPort` instead.
  # This way the user can more easily understand what is being requested and can more easily
  # reroute when desired.

  getTcpPort @0 (portNum :UInt16) -> (port :TcpPort);
  getUdpPort @1 (portNum :UInt16) -> (port :UdpPort);
}

interface TcpPort @0xeab20e1af07806b4 {
  # Capability to connect to a remote network port.
  #
  # An application may request a TcpPort from the Powerbox in order to request permission to
  # form a TCP connection to an arbitrary address.
  #
  # An application may offer a TcpPort to the Powerbox in order to implement a TCP server and
  # request that it be mapped to an address.
  #
  # While intended to represent a real IP address/port, this interface may in fact be offered and
  # received between two apps through the Powerbox, in which case there is in fact no IP address
  # assigned.

  connect @0 (downstream :Util.ByteStream) -> (upstream :Util.ByteStream);
  # Opens a new byte stream connection. The callee sends bytes to the caller via `downstream`, while
  # the caller sends bytes to the callee via `upstream`. Notice that the caller may start sending
  # bytes via pipelining immediately.

  connectTls @1 (downstream :Util.ByteStream) -> (upstream :Util.ByteStream);
  # Opens a new byte stream connection layered on top of Transport Layer Security, seamlessly
  # hiding the details of session negotiation and encryption.
}

interface UdpPort @0xc6212e1217d001ce {
  # Like `TcpPort` but for datagrams.

  send @0 (message :Data, returnPort :UdpPort);
  # Send a datagram.
  #
  # As always with UDP, successful return does not indicate successful delivery. On the receiving
  # end, a message may be delivered multiple times and/or may be truncated. It is the app's
  # responsibility to deal with ACKs, timeouts, message ordering, de-duplification, and data
  # integrity.
  #
  # `returnPort` may be used to send a direct reply. On the sending side, if the datagram is sent as
  # a real UDP packet, `returnPort` will be bound to an ephemeral port for a short time to receive
  # this reply. If `returnPort` is already bound to a port (either explicitly, or because it was
  # used in a previous `sendDatagram` call), then IP bridge implementation will reuse that binding
  # rather than allocate a new one. Therefore, frequently sending datagrams with the same
  # `returnPort` should have the effect of keeping the real IP address/port constant (this is
  # analogous to how NATs typically handle UDP traffic).
  #
  # TODO(someday): Cap'n Proto should support marking methods as "fast-but-unreliable", with all
  #   the properties of UDP. Then, this method should be marked as such.
}

struct IpPortPowerboxMetadata {
  # When making a Powerbox request for or offer of a `TcpPort` or `UdpPort`, this metadata may be
  # specified to refine the request / offer.
  #
  # TODO(soon): This is currently more of a concept, as we have not yet decided how "metadata"
  #   should be attached to Powerbox requests or offers.

  preferredPortNum @0 :UInt16;
  # The "standard" port number for the service being offered / requested.
  #
  # For Powerbox requests, this is used to fill in the port number of the remote service. The
  # user then only needs to fill in a hostname or IP. The user may override the port if desired.
  #
  # For Powerbox offers, this is used to specify the port to which the service ought to be bound,
  # although the user may override it.

  preferredHost @1 :Text;
  # If non-empty, contains the port's expected/preferred host name. Like preferredPortNum, this is
  # used to prefill forms, but the user may override. A textual representation of an IP address
  # (v4 or v6) is also allowed here.
  #
  # If possible, design your app so that the powerbox interaction is the point where the hostname
  # is specified in the first place. For example, if your app asks the user to specify a host to
  # connect to, and then immediately makes a powerbox request for that host, consider instead not
  # asking the user for a hostname at all and instead making the Powerbox request right off and
  # letting the user specify the hostname there.
}

interface PersistentIpNetwork extends (IpNetwork, SystemPersistent) {}
interface PersistentIpInterface extends (IpInterface, SystemPersistent) {}
