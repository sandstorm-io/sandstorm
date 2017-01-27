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

Sandcats = {};

import { pki, asn1 } from "node-forge";
const querystring = Npm.require("querystring");
const https = Npm.require("https");
const fs = Npm.require("fs");
const dgram = Npm.require("dgram");
const Url = Npm.require("url");

import { SANDSTORM_ALTHOME } from "/imports/server/constants.js";

const SANDCATS_HOSTNAME = (Meteor.settings && Meteor.settings.public &&
                           Meteor.settings.public.sandcatsHostname);
const SANDCATS_VARDIR = (SANDSTORM_ALTHOME || "") + "/var/sandcats";

const ROOT_URL = Url.parse(process.env.ROOT_URL);
const HOSTNAME = ROOT_URL.hostname;
let SANDCATS_NAME; // Look at `startup` below to see where this is set

const updateSandcatsIp = () => {
  const responseCallback = (res) => {
    if (res.statusCode === 200) {
      console.log("Successfully updated sandcats IP");
    } else {
      console.error("Failed to update sandcats IP:", res.headers);
    }
  };

  const errorCallback = (err) => {
    console.error("Couldn't send update sandcats hostname", err);
  };

  performSandcatsRequest("/update", SANDCATS_HOSTNAME, { rawHostname: SANDCATS_NAME },
                         errorCallback, responseCallback);
};

const pingUdp = () => {
  const socket = dgram.createSocket("udp4");
  const secret = Random.secret(16);

  message = new Buffer(SANDCATS_NAME + " " + secret);
  socket.on("message", (buf) => {
    if (buf.toString() === secret) {
      updateSandcatsIp();
    } else {
      console.error("Received unexpected response in UDP sandcats ping:", buf.toString());
    }
  });

  socket.on("error", (err) => {
    throw err;
  });

  socket.bind({ address: process.env.BIND_IP }, () => {
    socket.send(message, 0, message.length, 8080, SANDCATS_HOSTNAME, (err) => {
      if (err) {
        console.error("Couldn't send UDP sandcats ping", err);
      }
    });

    setTimeout(() => {
      socket.close();
    }, 10 * 1000);
  });
};

const performSandcatsRequest = (path, hostname, postData, errorCallback, responseCallback) => {
  const options = {
    hostname: hostname,
    path: path,
    localAddress: process.env.BIND_IP,
    method: "POST",
    agent: false,
    key: fs.readFileSync(SANDCATS_VARDIR + "/id_rsa"),
    cert: fs.readFileSync(SANDCATS_VARDIR + "/id_rsa.pub"),
    headers: {
      "X-Sand": "cats",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };

  if (postData.certificateSigningRequest) {
    console.log("Submitting certificate request for host",
                postData.rawHostname, "where the request has length",
                postData.certificateSigningRequest.length);
  }

  const newPostData = querystring.stringify(postData);
  if ((SANDCATS_HOSTNAME === "sandcats-dev.sandstorm.io") &&
      !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    console.log("You are using the Sandcats dev server but have full HTTPS " +
                "certificate checking enabled. Probably you will get an HTTPS " +
                "error. Proceeding anyway.");
  }

  const req = https.request(options, responseCallback);
  req.write(newPostData);
  req.end();

  if (errorCallback) {
    req.on("error", errorCallback);
  }

  return req;
};

const generateKeyAndCsr = (commonName) => {
  check(commonName, String);

  // Generate key pair. Using Meteor.wrapAsync because forge supports
  // a synchronous as well as an asynchronous API, and the synchronous
  // one blocks for a while.
  const wrappedGenerateKeyPair = Meteor.wrapAsync(pki.rsa.generateKeyPair);

  // I could pick an `e`[xponent] value for the resulting RSA key, but
  // I will refrain.
  const keys = wrappedGenerateKeyPair({ bits: 2048 });

  // Create a certificate request (CSR).
  const csr = pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    {
      name: "commonName",
      value: commonName,
      valueTagClass: asn1.Type.UTF8,
      // We specify UTF8 to encode a UTF8String (rather than the default of PRINTABLESTRING) in the
      // commonName so that GlobalSign does not report a warning, and also because that happens to
      // be what openssl(1) does when asked to create a CSR.
    },
  ]);
  csr.sign(keys.privateKey);
  console.log("generateKeyAndCsr created new key & certificate request for", commonName);
  return {
    privateKeyAsPem: pki.privateKeyToPem(keys.privateKey),
    csrAsPem: pki.certificationRequestToPem(csr),
  };
};

Sandcats.storeNewKeyAndCsr = (hostname, basePath) => {
  // We use the current JS time (like UNIX timestamp but in
  // milliseconds) as the key number. Note that the keyNumber is
  // intended to be an opaque identifier; the only important thing is
  // that it increases numerically over time. We use the current time
  // just as a simplistic way to pick a filename that probably no one
  // else has created yet.
  const keyNumber = new Date().getTime();
  const keyFilename = basePath + "/" + keyNumber;
  const csrFilename = keyFilename + ".csr";
  const responseFilename = keyFilename + ".response-json";
  const withWildcard = "*." + hostname;
  const keyAndCsr = generateKeyAndCsr(withWildcard);
  fs.writeFileSync(keyFilename, keyAndCsr.privateKeyAsPem,
                   { mode: 0400 });
  fs.writeFileSync(csrFilename, keyAndCsr.csrAsPem);
  console.log("storeNewKeyAndCsr successfully saved key and certificate request to",
              keyFilename, "and", csrFilename, "respectively of length",
              keyAndCsr.privateKeyAsPem.length, "and",
              keyAndCsr.csrAsPem.length);
  return {
    csrFilename: csrFilename,
    keyFilename: keyFilename,
    responseFilename: responseFilename,
  };
};

Sandcats.renewHttpsCertificateIfNeeded = () => {
  const renewHttpsCertificate = () => {
    const hostname = Url.parse(process.env.ROOT_URL).hostname;
    const basePath = "/var/sandcats/https/" + (hostname);
    const filenames = Sandcats.storeNewKeyAndCsr(hostname, basePath);

    const errorCallback = (err) => {
      console.error("Error while renewing HTTPS certificate (will continue to retry)", err);
    };

    const responseCallback = (res) => {
      if (res.statusCode == 200) {
        // Save the response, chunk by chunk, then store it on disk
        // for later use.
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk;
        });

        res.on("end", () => {
          // For sanity, make sure it parses as JSON, since we're
          // going to need it to do that.
          try {
            JSON.parse(responseBody);
          } catch (e) {
            console.error("JSON parse error receiving new HTTPS certificate. Discarding:",
                          responseBody,
                          "due to exception:",
                          e);
            // Overwrite the responseBody with the empty JSON object
            // and continue with the process of saving it to disk.
            responseBody = "{}";
          }

          try {
            fs.writeFileSync(filenames.responseFilename, responseBody, "utf-8");
          } catch (err) {
            return console.error("Failure while saveing new HTTPS certificate to",
                                 filenames.responseFilename,
                                 "will continue to retry. Exception was:",
                                 err);
          }

          // Tell Sandcats that now is a good time to update its info
          // about which keys are available.
          if (!global.sandcats) {
            console.error("When getting new certificate, could not find callback to request re-keying! Certs will probably become invalid soon.");
          } else {
            // Call the sandcats rekeying function.
            global.sandcats.rekey();
            // That's that.
            console.log("Successfully renewed HTTPS certificate into",
                        filenames.responseFilename);
          }
        });
      } else {
        console.log("Received HTTP error while renewing certificate (will keep retrying)",
                    res.statusCode);
        res.on("data", (chunk) => {
          console.log("Error response contained information", chunk.toString("utf-8"));
        });
      }
    };

    const wrappedReadFile = Meteor.wrapAsync(fs.readFile);

    performSandcatsRequest("/getcertificate", SANDCATS_HOSTNAME, {
      rawHostname: SANDCATS_NAME,
      certificateSigningRequest: wrappedReadFile(filenames.csrFilename, "utf-8"),
    }, errorCallback, responseCallback);
  };

  if (global.sandcats.shouldGetAnotherCertificate()) {
    console.log("renewHttpsCertificateIfNeeded: Happily choosing to renew certificate.");
    return renewHttpsCertificate();
  }
};

Sandcats.initializeSandcats = () => {
  const i = HOSTNAME.lastIndexOf(SANDCATS_HOSTNAME);
  if (i < 0) {
    console.error("SANDCATS_BASE_DOMAIN is configured but your HOSTNAME doesn't appear to contain it:",
                  SANDCATS_HOSTNAME, HOSTNAME);
  } else {
    const oneMinute = 60 * 1000;
    const oneHour = 60 * oneMinute;
    const randomIntervalZeroToOneHour = Math.random() * oneHour;
    // All Sandcats installs need dyndns updating.
    SANDCATS_NAME = HOSTNAME.slice(0, i - 1);
    Meteor.setInterval(pingUdp, oneMinute);
    // If process.env.HTTPS_PORT is set, we need to auto-refresh our HTTPS certificate.
    if (process.env.HTTPS_PORT) {
      // Always do a HTTPS certificate update check on Sandstorm start.
      Sandcats.renewHttpsCertificateIfNeeded();

      // After that's done, schedule it for every approx 1-2 hours in
      // the future.
      Meteor.setInterval(Sandcats.renewHttpsCertificateIfNeeded,
                         oneHour + randomIntervalZeroToOneHour);
    }
  }
};

if (SANDCATS_HOSTNAME) {
  Meteor.startup(Sandcats.initializeSandcats);
};
