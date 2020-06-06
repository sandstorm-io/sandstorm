// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2020 Sandstorm Development Group, Inc. and contributors
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
import { waitPromise } from "/imports/server/async-helpers.ts";
import ACME from "@root/acme";
import CSR from "@root/csr";
import PEM from "@root/pem";
import Keypairs from "@root/keypairs";
import { pki, asn1 } from "node-forge";
import { SandstormDb } from "/imports/sandstorm-db/db.js";
import { globalDb } from "/imports/db-deprecated.js";
import URL from "url";
import { getSandcatsAcmeOptions, getSandcatsName } from "/imports/server/sandcats.js";
import Crypto from "crypto";

// Relevant settings in database `Settings` table:
// * {_id: "tlsKeys", value: {key: "<PEM>", certChain: "<PEM>"}}
// * {_id: "acmeAccount", value: { directory: "https://acme-v02.api.letsencrypt.org/directory",
//                                 email: "foo@example.com",
//                                 account: {<what acme.accounts.create() returns>},
//                                 key: {<jwk>}}}
// * {_id: "acmeChallenge", value: {module: "whatever", options: {...}}}
//   The module name will be prefixed with "acme-dns-01-" and imported. Ignored when hostname is
//   sandcats.io.
// * {_id: "tlsStatus", value: {expires: Date, renewAt: Date, currentlyRenewing: Boolean}}
//   A fake setting that is directly managed by this file in order to report the current status.
//   TODO(cleanup): Implement a proper pseudo-collection.

const SECONDS = 1000;
const HOURS = 3600 * SECONDS;
const DAYS = 24 * HOURS;

function createAcmeClient(directory) {
  // Compute package agent identifier (like a User-Agent).
  let build = Meteor.settings && Meteor.settings.public && Meteor.settings.public.build;
  let packageAgent;
  if (typeof build === "number") {
    packageAgent = "Sandstorm/v" + Math.floor(build) + "." + (build % 1000);
  } else {
    packageAgent = "SandstormDevServer/v0";
  }

  // Create ACME client.
  let acme = ACME.create({
    maintainerEmail: "security+acme@sandstorm.io",
    packageAgent,
    notify(ev, args) {
      console.log("ACME.js notification:", ev, args);
    }
  });

  if (directory) {
    waitPromise(acme.init(directory));
  }

  return acme;
}

// By default ACME.js phones home to their servers to track e-mail addresses of maintainers in
// order to send security notices. We have already registered security+acme@sandstorm.io as a
// maintainer, so doing it again is redundant, and we don't want everyone's Sandstorm servers
// pinging an unexpected third party. So, we monkey-patch the library to remove this call.
import Maintainers from "@root/acme/maintainers.js";
if (!Maintainers.init) {
  throw new Error("code to monkey-patch ACME.js needs update");
}
Maintainers.init = (me) => {};

export function createAcmeAccount(directory, email, agreeToTerms) {
  let accountKeypair = waitPromise(Keypairs.generate({ kty: 'EC', format: 'jwk' }));
  let accountKey = accountKeypair.private;

  let acme = createAcmeClient(directory);

  let account = waitPromise(acme.accounts.create({
      subscriberEmail: email, agreeToTerms, accountKey}));

  globalDb.collections.settings.upsert({_id: "acmeAccount"}, {$set: {
    value: {
      directory,
      email,
      account,
      key: accountKey
    }
  }});
}

let currentlyRenewing = false;

export function renewCertificateNow() {
  let accountInfo = globalDb.getSetting("acmeAccount");
  if (!accountInfo) {
    console.log("Can't renew certificate because ACME account info is not configured.");
    return false;
  }

  let challengeOpts;
  if (URL.parse(process.env.ROOT_URL).hostname.endsWith(".sandcats.io")) {
    challengeOpts = {
      module: "sandcats",
      options: getSandcatsAcmeOptions()
    };
  } else {
    challengeOpts = globalDb.getSetting("acmeChallenge");
    if (!challengeOpts) {
      console.log("Can't renew certificate because ACME challenge is not configured.");
      return false;
    }
  }

  if (currentlyRenewing) {
    console.log("Tried to initiate certificate renewal when another renewal is already running. " +
        "If you must cancel the existing renewal process, please restart Sandstorm.");
    return false;
  }

  currentlyRenewing = true;
  try {
    globalDb.collections.settings.upsert({_id: "tlsStatus"}, {$set: {"value.currentlyRenewing": true}});
    renewCertificateNowImpl(accountInfo, challengeOpts)
  } finally {
    currentlyRenewing = false;
    globalDb.collections.settings.upsert({_id: "tlsStatus"}, {$set: {"value.currentlyRenewing": false}});
  }
}

function renewCertificateNowImpl(accountInfo, challengeOpts) {
  let challenge = Npm.require("acme-dns-01-" + challengeOpts.module)
      .create(challengeOpts.options);

  // Compute domains list.
  let baseHost = URL.parse(process.env.ROOT_URL).hostname;
  // URL.parse(globalDb.getWildcardOrigin()) doesn't work because `*` is not a valid character in
  // hostnames so the parser ends up parsing the hostname as a path component instead. We'll have
  // to split manually.
  let wildcard = globalDb.getWildcardOrigin().split("://")[1].split(":")[0];
  let domains = [baseHost, wildcard];

  // Generate private key.
  let tlsKeypair = waitPromise(Keypairs.generate({ kty: "RSA", format: "jwk" }));
  let privatePem = waitPromise(Keypairs.export({jwk: tlsKeypair.private}));

  // Generate CSR.
  let csrDer = waitPromise(CSR.csr({jwk: tlsKeypair.private, domains, encoding: "der"}));
  let csr = PEM.packBlock({type: "CERTIFICATE REQUEST", bytes: csrDer});

  // Compute package agent identifier (like a User-Agent).
  let build = Meteor.settings && Meteor.settings.public && Meteor.settings.public.build;
  let packageAgent;
  if (typeof build === "number") {
    packageAgent = "sandstorm/" + Math.floor(build) + "." + (build % 1000);
  } else {
    packageAgent = "sandstorm/dev";
  }

  // Create ACME client.
  let acme = createAcmeClient(accountInfo.directory);

  // Get the certificates!
  let pems = waitPromise(acme.certificates.create({
    account: accountInfo.account,
    accountKey: accountInfo.key,
    csr, domains,
    challenges: {"dns-01": challenge},

    // Sandcats doesn't support setting TXT on arbitrary hostnames, therefore doesn't support dry
    // runs.
    skipDryRun: baseHost.endsWith(".sandcats.io")
  }));

  let certChain = pems.cert + "\n" + pems.chain + "\n";

  // Stick them in the database, which automatically triggers updating the gateway to use the new
  // keys.
  globalDb.collections.settings.upsert({_id: "tlsKeys"}, {$set: {
    value: {
      key: privatePem,
      certChain
    }
  }});

  console.log("Certificate was successfully renewed!");

  return true;
}

function notifyAdminOfCertificateExpiration(expirationDate) {
  // TODO
}

function removeAllCertificateExpirationNotifications() {
  // TODO
}

let nextRenewalTimeout = null;
let renewSchedulerVersion = 0;
function renewCertificateWhenNeeded(certChain) {
  if (nextRenewalTimeout) {
    Meteor.clearTimeout(nextRenewalTimeout);
    nextRenewalTimeout = null;
  }
  let myVersion = ++renewSchedulerVersion;

  if (!certChain) {
    removeAllCertificateExpirationNotifications();
    return;
  }

  let validity = pki.certificateFromPem(certChain).validity;
  let now = Date.now();

  // Calculate the point in time that is 2/3 through the validity period, though if the validity
  // period is more than 90 days, clamp it to the last 90 days. This is largely based on Let's
  // Encrypt's recommendation to renew their certificates every 60 days, even though the cert is
  // valid for 90 days. Note that Let's Encrypt will send a reminder e-mail if the certificate
  // hasn't been renewed after 70 days; we'd like to avoid that.
  let end = validity.notAfter.getTime();
  let start = Math.max(validity.notBefore.getTime(), end - 90 * DAYS);
  let targetTime = Math.floor(start + (end - start) * 2 / 3);

  // A timeout of more than 2^31 will break setTimeout(), so clamp to a max of 7 days, and we'll
  // just re-run the whole timeout computation then.
  let timeout = Math.min(7 * DAYS, targetTime - now);

  globalDb.collections.settings.upsert({_id: "tlsStatus"},
      {$set: {"value.expires": validity.notAfter, "value.renewAt": new Date(targetTime)}});

  if (now > targetTime) {
    console.log("TLS certificate is near expiration; renewing now.");
    try {
      if (!renewCertificateNow()) {
        notifyAdminOfCertificateExpiration(validity.notAfter);
      }
      return;
    } catch (err) {
      // If nothing changes, retry every 6 hours.
      console.error("Failed to renew certificate (will try again in 6 hours):", err.stack);
      timeout = 6 * HOURS;
    }
  } else {
    console.log("Planning to renew certificate at:", new Date(targetTime));
  }

  if (renewSchedulerVersion > myVersion) {
    // Crap, someone called renewCertificateWhenNeeded() concurrently. The later call should "win".
    return;
  } else {
    nextRenewalTimeout = Meteor.setTimeout(() => {
      renewCertificateWhenNeeded(certChain);
    }, timeout);

    removeAllCertificateExpirationNotifications();
  }
}

function computeLetsEncryptSwitchDate(hostname) {
  // Compute a time in the future which will be no more than 2^31 milliseconds from now (so we can
  // use setTimeout() safely).

  // Hash the hostname, and parse the first 32 bits as an integer.
  let offset =
      parseInt(Crypto.createHash("sha256").update(hostname).digest("hex").slice(0, 8), 16);
  // Divide by 4 so it's less than 2^30.
  offset = Math.floor(offset / 4);
  // Add that to the rollout start date, which is in the very near future as of this writing.
  let ROLLOUT_START = new Date('2020-06-10');
  return new Date(ROLLOUT_START.getTime() + offset);
}

function switchSandcatsToLetsEncrypt(sandcatsName) {
  // Check again that no one has created an account in the meantime.
  if (!globalDb.getSetting("acmeAccount")) {
    console.log("Automatically creating Let's Encrypt account. Sandcats certificates will be " +
        "fetched from Let's Encrypt from now on.");

    // As of this writing, mail sent to anything+letsencrypt@sandcats.io gets logged to a place
    // only Kenton can see, but in the future we may make hostname[+anything]@sandcats.io forward
    // to the owner of the hostname using their e-mail address on file. We'd need to implement some
    // sort of e-mail verification before doing that, though.
    createAcmeAccount("https://acme-v02.api.letsencrypt.org/directory",
        sandcatsName + "+letsencrypt@sandcats.io", true);

    let tlsKeys = globalDb.getSetting("tlsKeys");
    if (tlsKeys && tlsKeys.certChain) {
      renewCertificateWhenNeeded(tlsKeys.certChain);
    }
  }
}

// On replica 0, subscribe to updates to the `tlsKeys` setting and renew the certificate when
// needed.
if (!Meteor.settings.replicaNumber) {
  Meteor.startup(() => {
    globalDb.collections.settings.remove({_id: "tlsStatus"});

    // We don't want this to block startup, so put it in a zero-time setTimeout().
    Meteor.setTimeout(() => {
      globalDb.collections.settings.find({_id: "tlsKeys"}).observe({
        added(setting) { renewCertificateWhenNeeded(setting.value.certChain); },
        changed(newSetting, oldSetting) { renewCertificateWhenNeeded(newSetting.value.certChain); },
        removed(setting) { renewCertificateWhenNeeded(null); },
      });
    }, 0);

    let sandcatsName = getSandcatsName();
    if (sandcatsName && !globalDb.getSetting("acmeAccount")) {
      // We're using old sandcats cert flow. Arrange to migrate to Let's Encrypt.
      let timeout = computeLetsEncryptSwitchDate(sandcatsName).getTime() - Date.now();
      if (timeout <= 0) {
        // We were supposed to have switched already. Switch at a random time in the next day.
        timeout = Math.floor(Math.random() * DAYS) + 1;
      }

      if (timeout >= Math.pow(2, 31)) {
        // Yikes, setTimeout() will do the wrong thing if we set this.
        console.log("Error calculating Let's Encrypt auto-migration!", timeout);
      } else {
        console.log("Planning to migrate to Let's Encrypt automatically at:",
            new Date(Date.now() + timeout));

        Meteor.setTimeout(() => {
          switchSandcatsToLetsEncrypt(sandcatsName);
        }, timeout);
      }
    }
  });
}
