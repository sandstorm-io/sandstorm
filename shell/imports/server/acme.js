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
import { inMeteor, waitPromise } from "/imports/server/async-helpers.js";
import ACME from "@root/acme";
import CSR from "@root/csr";
import PEM from "@root/pem";
import Keypairs from "@root/keypairs";
import { pki, asn1 } from "node-forge";
import { SandstormDb } from "/imports/sandstorm-db/db.js";
import { globalDb } from "/imports/db-deprecated.js";
import URL from "url";

// Relevant settings in database `Settings` table:
// * {_id: "tlsKeys", value: {key: "<PEM>", certChain: "<PEM>"}}
// * {_id: "acmeAccount", value: { directory: "https://acme-v02.api.letsencrypt.org/directory",
//                                 email: "foo@example.com",
//                                 account: {<what acme.accounts.create() returns>},
//                                 key: {<jwk>}}}
// * {_id: "acmeChallenge", value: {module: "whatever", options: {...}}}
//   The module name will be prefixed with "acme-dns-01-" and imported.

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

  waitPromise(acme.init(directory));

  return acme;
}

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

export function renewCertificateNow() {
  let accountInfo = globalDb.getSetting("acmeAccount");
  if (!accountInfo) {
    console.log("Can't renew certificate because ACME account info is not configured.");
    return false;
  }

  let challengeOpts = globalDb.getSetting("acmeChallenge");
  if (!challengeOpts) {
    console.log("Can't renew certificate because ACME challenge is not configured.");
    return false;
  }
  let challenge = Npm.require("acme-dns-01-" + challengeOpts.module)
      .create(challengeOpts.options);

  // Compute domains list.
  let baseHost = URL.parse(process.env.ROOT_URL).hostname;
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
    challenges: {"dns-01": challenge}
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

  // Calculate the point in time that is 75% through the validity period, though if the validity
  // period is more than 90 days, clamp it to the last 90 days.
  let end = validity.notAfter.getTime();
  let start = Math.max(validity.notBefore.getTime(), end - 90 * DAYS);
  let targetTime = start + 0.75 * (end - start);

  // A timeout of more than 2^31 will break setTimeout(), so clamp to a max of 7 days, and we'll
  // just re-run the whole timeout computation then.
  let timeout = Math.min(7 * DAYS, targetTime - now);

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

// On replica 0, subscribe to updates to the `tlsKeys` setting and renew the certificate when
// needed.
if (!Meteor.settings.replicaNumber) {
  Meteor.startup(() => {
    // We don't want this to block startup, so put it in a zero-time setTimeout().
    Meteor.setTimeout(() => {
      globalDb.collections.settings.find({_id: "tlsKeys"}).observe({
        added(setting) { renewCertificateWhenNeeded(setting.value.certChain); },
        changed(newSetting, oldSetting) { renewCertificateWhenNeeded(newSetting.value.certChain); },
        removed(setting) { renewCertificateWhenNeeded(null); },
      });
    }, 0);
  });
}