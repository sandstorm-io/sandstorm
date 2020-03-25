// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2017 Sandstorm Development Group, Inc. and contributors
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

import { Meteor } from "meteor/meteor";
import Dns from "dns";
import Ip from "ip";
import Url from "url";

import { SPECIAL_IPV4_ADDRESSES, SPECIAL_IPV6_ADDRESSES } from "/imports/constants.js";

const lookupInFiber = Meteor.wrapAsync(Dns.lookup, Dns);

function getNetwork(addr, bits) {
  // npm ip's "mask" and "cidr" functions are broken for ipv6. :(

  const parsed = Ip.toBuffer(addr);

  for (let i = Math.ceil(bits / 8); i < parsed.length; i++) {
    parsed[i] = 0;
  }

  const n = Math.floor(bits / 8);
  if (n < parsed.length) {
    parsed[n] = parsed[n] & (0xff << (8 - bits % 8));
  }

  return parsed;
}

function parseCidr(cidr) {
  // Given a CIDR-format network specification, return a function which, given an address string,
  // returns true if the address is in this network.

  // The "ip" NPM module's CIDR handling unfortunately is very broken for IPv6. Many bugs have been
  // filed but it remains broken.

  try {
    cidr = cidr.trim();
    if (cidr === "") return null;

    const parts = cidr.split("/");
    if (parts.length === 1) {
      // Bare address.
      return addr => Ip.isEqual(cidr, addr);
    } else if (parts.length === 2) {
      const bits = parseInt(parts[1], 10);
      if (bits !== bits) throw new Error("value after slash must be an integer");
      const network = getNetwork(parts[0], bits);
      return addr => {
        return network.equals(getNetwork(addr, bits));
      };
    } else {
      throw new Error("too many slashes");
    }
  } catch (err) {
    console.error("invalid network specification in IP blacklist:", cidr, err);
    return null;
  }
}

SPECIAL_FILTERS = SPECIAL_IPV4_ADDRESSES.concat(SPECIAL_IPV6_ADDRESSES).map(parseCidr);

function ssrfSafeLookup(db, url) {
  // Given an HTTP/HTTPS URL, look up the hostname, verify it doesn't point to a blacklisted IP,
  // then return an object of {url, host}, where `url` has the original hostname substituted with
  // an IP address, and `host` is the original hostname suitable for sending in the `Host` header.

  const parsedUrl = Url.parse(url);

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("not an HTTP nor HTTPS URL: " + url);
  }

  const addresses = lookupInFiber(parsedUrl.hostname, { all: true, hints: Dns.ADDRCONFIG });

  // TODO(perf): Subscribe to blacklist changes so that we don't have to do a new lookup and
  //   parse each time.
  const blacklist = db.getSettingWithFallback("ipBlacklist", "")
      .split("\n").map(parseCidr).filter(x => x);

  for (let i in addresses) {
    const address = addresses[i];
    if (address.family !== 4 && address.family !== 6) continue;

    let ok = true;
    blacklist.forEach(test => { if (test(address.address)) { ok = false; } });

    SPECIAL_FILTERS.forEach(test => { if (test(address.address)) { ok = false; } });

    if (ok) {
      const host = parsedUrl.host;
      delete parsedUrl.host;
      parsedUrl.hostname = address.address;
      return { url: Url.format(parsedUrl), host };
    }
  }

  if (addresses.length > 0) {
    throw new Meteor.Error(403,
        "can't connect to blacklisted private network address: " + parsedUrl.hostname +
        "; the Sandstorm server admin can change the blacklist in the admin settings");
  } else {
    throw new Meteor.Error(404, "host not found: " + parsedUrl.hostname);
  }
}

function ssrfSafeLookupOrProxy(db, url) {
  // If there is an HTTP proxy, then it will have to do the work of blacklisting IPs, because it's
  // the proxy that does the DNS lookup.
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;

  if (httpProxy && url.startsWith("http:")) {
    return { proxy: httpProxy };
  } else if (httpsProxy && url.startsWith("https:")) {
    return { proxy: httpsProxy };
  } else {
    return ssrfSafeLookup(db, url);
  }
}

function ssrfSafeHttp(originalHttpCall, db, method, url, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }

  if (!options) options = {};

  if (options.npmRequestOptions && options.npmRequestOptions.proxy) {
    // Request already specifies a different proxy.
    return originalHttpCall(method, url, options, callback);
  }

  const safe = ssrfSafeLookupOrProxy(db, url);

  if (safe.proxy) {
    if (!options.npmRequestOptions) options.npmRequestOptions = {};
    options.npmRequestOptions.proxy = safe.proxy;
    return originalHttpCall(method, url, options, callback);
  } else {
    const safe = ssrfSafeLookup(db, url);
    if (!options.headers) options.headers = {};
    options.headers.host = safe.host;
    options.servername = safe.host.split(":")[0];
    return originalHttpCall(method, safe.url, options, callback);
  }
}

function monkeyPatchHttp(db, HTTP) {
  const original = HTTP.call.bind(HTTP);
  HTTP.call = ssrfSafeHttp.bind(this, original, db);
}

export { ssrfSafeLookup, ssrfSafeLookupOrProxy, monkeyPatchHttp };
