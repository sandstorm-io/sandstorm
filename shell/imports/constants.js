// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

const ACCOUNT_DELETION_SUSPENSION_TIME = 7 * 60 * 60 * 24 * 1000; // 7 days in ms

// Lists below developed from RFC6890, which is an overview of all special addresses.
const PRIVATE_IPV4_ADDRESSES = [
  "10.0.0.0/8",            // RFC1918 reserved for internal network
  "127.0.0.0/8",           // RFC1122 loopback / localhost
  "169.254.0.0/16",        // RFC3927 "link local" (auto-configured LAN in absence of DHCP)
  "172.16.0.0/12",         // RFC1918 reserved for internal network
  "192.168.0.0/16",        // RFC1918 reserved for internal network
];

const PRIVATE_IPV6_ADDRESSES = [
  "::1/128",               // RFC4291 loopback / localhost
  "fc00::/7",              // RFC4193 unique private network
  "fe80::/10",             // RFC4291 "link local" (auto-configured LAN in absence of DHCP)
];

const SPECIAL_IPV4_ADDRESSES = [
  "0.0.0.0/8",             // RFC1122 "this host" / wildcard
  "100.64.0.0/10",         // RFC6598 "shared address space" for carrier-grade NAT
  "192.0.0.0/24",          // RFC6890 reserved for special protocols
  "192.0.2.0/24",          // RFC5737 "example address" block 1 -- like example.com for IPs
  "192.88.99.0/24",        // RFC3068 6to4 relay
  "198.18.0.0/15",         // RFC2544 standard benchmarks
  "198.51.100.0/24",       // RFC5737 "example address" block 2 -- like example.com for IPs
  "203.0.113.0/24",        // RFC5737 "example address" block 3 -- like example.com for IPs
  "224.0.0.0/4",           // RFC1112 multicast
  "240.0.0.0/4",           // RFC1112 multicast / reserved for future use
  "255.255.255.255/32"     // RFC0919 broadcast address
];

const SPECIAL_IPV6_ADDRESSES = [
  "::/128",                // RFC4291 unspecified address / wildcard
  "64:ff9b::/96",          // RFC6052 IPv4-IPv6 translation
  "::ffff:0:0/96",         // RFC4291 IPv4-mapped address
                           // TODO(someday): I don't understand the difference between the above
                           //     two. Both are described as mapping ip4 addresses into the ip6
                           //     space. Perhaps this should be allowed, however, we'd need to
                           //     filter the ip4 address against the ip4 blacklist, so special
                           //     handling would be needed.
  "100::/64",              // RFC6666 discard-only address block
  "2001::/23",             // RFC2928 reserved for special protocols
  "2001:2::/48",           // RFC5180 standard benchmarks
  "2001:db8::/32",         // RFC3849 "example address" block -- like example.com for IPs
  "2001:10::/28",          // RFC4843 ORCHID
  "2002::/16",             // RFC3056 6to4 relay
  "ff00::/8",              // RFC4291 multicast
];

export {
  ACCOUNT_DELETION_SUSPENSION_TIME, PRIVATE_IPV4_ADDRESSES, PRIVATE_IPV6_ADDRESSES,
  SPECIAL_IPV4_ADDRESSES, SPECIAL_IPV6_ADDRESSES
};
