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
import { Address4, Address6 } from "ip-address";
import Url from "url";
import Agent from "undici/lib/dispatcher/agent";
import ProxyAgent from "undici/lib/dispatcher/proxy-agent";

import { SPECIAL_IPV4_ADDRESSES, SPECIAL_IPV6_ADDRESSES } from "/imports/constants";

const lookupAsync = Dns.lookup.bind(Dns);

function parseAddress(addr) {
  if (Address4.isValid(addr)) {
    return { familyBits: 32, bytes: Buffer.from(new Address4(addr).toArray()) };
  }

  if (Address6.isValid(addr)) {
    const parsed = new Address6(addr);
    const unsignedBytes = Buffer.from(parsed.toUnsignedByteArray());
    if (unsignedBytes.length > 16) {
      throw new Error("invalid IPv6 address length");
    }

    if (unsignedBytes.length === 16) {
      return { familyBits: 128, bytes: unsignedBytes };
    }

    const bytes = Buffer.alloc(16);
    unsignedBytes.copy(bytes, 16 - unsignedBytes.length);
    return { familyBits: 128, bytes };
  }

  throw new Error("invalid IP address: " + addr);
}

function getNetwork(parsed, bits) {
  // npm ip's "mask" and "cidr" functions are broken for ipv6. :(

  const masked = Buffer.from(parsed.bytes);

  for (let i = Math.ceil(bits / 8); i < masked.length; i++) {
    masked[i] = 0;
  }

  const n = Math.floor(bits / 8);
  if (n < masked.length) {
    masked[n] = masked[n] & (0xff << (8 - bits % 8));
  }

  return masked;
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
      const parsed = parseAddress(cidr);
      return addr => {
        const candidate = parseAddress(addr);
        return parsed.familyBits === candidate.familyBits && parsed.bytes.equals(candidate.bytes);
      };
    } else if (parts.length === 2) {
      const bits = parseInt(parts[1], 10);
      if (bits !== bits) throw new Error("value after slash must be an integer");
      const cidrAddr = parseAddress(parts[0]);
      if (bits < 0 || bits > cidrAddr.familyBits) {
        throw new Error("invalid CIDR prefix length");
      }

      const network = getNetwork(cidrAddr, bits);
      return addr => {
        const candidate = parseAddress(addr);
        if (candidate.familyBits !== cidrAddr.familyBits) {
          return false;
        }

        return network.equals(getNetwork(candidate, bits));
      };
    } else {
      throw new Error("too many slashes");
    }
  } catch (err) {
    console.error("invalid network specification in IP blacklist:", cidr, err);
    return null;
  }
}

const SPECIAL_FILTERS = SPECIAL_IPV4_ADDRESSES.concat(SPECIAL_IPV6_ADDRESSES).map(parseCidr);

async function selectSafeAddress(db, parsedUrl, addresses) {
  // TODO(perf): Subscribe to blacklist changes so that we don't have to do a new lookup and
  //   parse each time.
  const blacklist = ((await db.getSettingAsync("ipBlacklist")) || "")
      .split("\n").map(parseCidr).filter(x => x);

  for (let i in addresses) {
    const address = addresses[i];
    if (address.family !== 4 && address.family !== 6) continue;

    let ok = true;
    blacklist.forEach(test => { if (test(address.address)) { ok = false; } });

    SPECIAL_FILTERS.forEach(test => { if (test(address.address)) { ok = false; } });

    if (ok) {
      const host = parsedUrl.host;
      const servername = parsedUrl.hostname;
      delete parsedUrl.host;
      parsedUrl.hostname = address.address;
      return {
        url: Url.format(parsedUrl),
        host,
        address: address.address,
        family: address.family,
        servername,
      };
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

async function ssrfSafeLookup(db, url) {
  // Given an HTTP/HTTPS URL, look up the hostname, verify it doesn't point to a blacklisted IP,
  // then return an object of {url, host}, where `url` has the original hostname substituted with
  // an IP address, and `host` is the original hostname suitable for sending in the `Host` header.

  const parsedUrl = Url.parse(url);

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("not an HTTP nor HTTPS URL: " + url);
  }

  const addresses = await new Promise((resolve, reject) => {
    lookupAsync(parsedUrl.hostname, { all: true, hints: Dns.ADDRCONFIG }, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });

  return await selectSafeAddress(db, parsedUrl, addresses);
}

async function ssrfSafeLookupOrProxy(db, url) {
  // If there is an HTTP proxy, then it will have to do the work of blacklisting IPs, because it's
  // the proxy that does the DNS lookup.
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;

  if (httpProxy && url.startsWith("http:")) {
    return { proxy: httpProxy };
  } else if (httpsProxy && url.startsWith("https:")) {
    return { proxy: httpsProxy };
  } else {
    return await ssrfSafeLookup(db, url);
  }
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 30000) {
  const fetchInit = { ...init };
  delete fetchInit.timeoutMs;
  const timeoutController = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutController.signal])
    : timeoutController.signal;
  const timeout = timeoutMs > 0
    ? setTimeout(() => timeoutController.abort(new Error("HTTP request timed out")), timeoutMs)
    : undefined;

  try {
    return await fetch(url, { ...fetchInit, signal });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function redirectedRequest(response, currentUrl, method, headers, body) {
  const location = response.headers.get("location");
  if (!location) return null;

  const nextUrl = new URL(location, currentUrl);
  const currentOrigin = new URL(currentUrl).origin;
  if (nextUrl.origin !== currentOrigin) {
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("proxy-authorization");
  }

  if (response.status === 303 && method !== "HEAD" ||
      (response.status === 301 || response.status === 302) && method === "POST") {
    method = "GET";
    body = undefined;
    headers.delete("content-length");
    headers.delete("content-type");
  }

  return { url: nextUrl.href, method, headers, body };
}

async function withSsrfSafeFetch(db, url, init = {}, consume) {
  if (typeof consume !== "function") {
    throw new TypeError("withSsrfSafeFetch() requires a response consumer");
  }

  const timeoutMs = init.timeoutMs === undefined ? 30000 : init.timeoutMs;
  const timeoutController = new AbortController();
  const callerSignal = init.signal;
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal;
  const timeout = timeoutMs > 0
    ? setTimeout(() => timeoutController.abort(new Error("HTTP request timed out")), timeoutMs)
    : undefined;

  let currentUrl = new URL(url).href;
  let method = (init.method || "GET").toUpperCase();
  let headers = new Headers(init.headers);
  let body = init.body;

  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const safe = await ssrfSafeLookupOrProxy(db, currentUrl);
      let dispatcher;
      if (safe.proxy) {
        dispatcher = new ProxyAgent(safe.proxy);
      } else {
        dispatcher = new Agent({
          connect: {
            servername: safe.servername,
            lookup(_hostname, _options, callback) {
              callback(null, safe.address, safe.family);
            },
          },
        });
      }

      let response;
      try {
        response = await fetchWithTimeout(currentUrl, {
          ...init,
          body,
          dispatcher,
          headers,
          method,
          redirect: "manual",
          signal,
        }, 0);

        if (![301, 302, 303, 307, 308].includes(response.status)) {
          return await consume(response);
        }

        if (redirects === 5) {
          throw new Error("HTTP redirect limit exceeded");
        }

        const redirected = redirectedRequest(response, currentUrl, method, headers, body);
        if (!redirected) return await consume(response);
        await response.body.cancel();
        ({ url: currentUrl, method, headers, body } = redirected);
      } finally {
        if (response && !response.bodyUsed) {
          await response.body.cancel().catch(() => {});
        }

        await dispatcher.close();
      }
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export {
  fetchWithTimeout,
  parseCidr,
  redirectedRequest,
  selectSafeAddress,
  ssrfSafeLookup,
  ssrfSafeLookupOrProxy,
  withSsrfSafeFetch,
};
