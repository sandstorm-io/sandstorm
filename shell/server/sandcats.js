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

var querystring = Npm.require("querystring");
var https = Npm.require("https");
var fs = Npm.require("fs");
var dgram = Npm.require("dgram");
var Url = Npm.require("url");

var SANDCATS_HOSTNAME = (Meteor.settings && Meteor.settings.public &&
                         Meteor.settings.public.sandcatsHostname || "sandcats-dev.sandstorm.io");
var SANDCATS_VARDIR = (SANDSTORM_ALTHOME || "") + "/var/sandcats";

var ROOT_URL = Url.parse(process.env.ROOT_URL);
var HOSTNAME = ROOT_URL.hostname;
var SANDCATS_NAME; // Look at `startup` below to see where this is set

function updateSandcatsIp() {
  var responseCallback = function(res) {
    if (res.statusCode === 200) {
      console.log("Successfully updated sandcats IP");
    } else {
      console.error("Failed to update sandcats IP:", res.headers);
    }
  };

  var errorCallback = function(err) {
    console.error("Couldn't send update sandcats hostname", err);
  };

  performSandcatsRequest("/update", SANDCATS_HOSTNAME, {rawHostname: SANDCATS_NAME},
                         errorCallback, responseCallback);
};

function pingUdp() {
  var socket = dgram.createSocket("udp4");
  var secret = Random.secret(16);

  message = new Buffer(SANDCATS_NAME + " " + secret);
  socket.on("message", function (buf) {
    if (buf.toString() === secret) {
      updateSandcatsIp();
    } else {
      console.error("Received unexpected response in UDP sandcats ping:", buf.toString());
    }
  });

  socket.send(message, 0, message.length, 8080, SANDCATS_HOSTNAME, function (err) {
    if (err) {
      console.error("Couldn't send UDP sandcats ping", err);
    }
  });

  Meteor.setTimeout(function () {
    socket.close();
  }, 10 * 1000);
};

function performSandcatsRequest(path, hostname, postData, errorCallback, responseCallback) {
  var options = {
    hostname: hostname,
    path: path,
    method: "POST",
    agent: false,
    key: fs.readFileSync(SANDCATS_VARDIR + "/id_rsa"),
    cert: fs.readFileSync(SANDCATS_VARDIR + "/id_rsa.pub"),
    headers: {
      "X-Sand": "cats",
      "Content-Type": "application/x-www-form-urlencoded"
    }
  };

  console.log("Submitting certificate request for host",
              postData.rawHostname, "where the request has length",
              postData.certificateSigningRequest.length);
  var post_data = querystring.stringify(postData);
  if ((SANDCATS_HOSTNAME === "sandcats-dev.sandstorm.io") &&
      ! process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    console.log("You are using the Sandcats dev server but have full HTTPS " +
                "certificate checking enabled. Probably you will get an HTTPS " +
                "error. Proceeding anyway.");
  }
  var req = https.request(options, responseCallback);
  req.write(post_data);
  req.end();

  if (errorCallback) {
    req.on('error', errorCallback);
  }
  return req;
}

var generateKeyAndCsr = function(commonName) {
  // This function relies on the this.forge object created by the
  // meteor-node-forge package.
  check(commonName, String);

  // Generate key pair. Using Meteor.wrapAsync because forge supports
  // a synchronous as well as an asynchronous API, and the synchronous
  // one blocks for a while.
  var wrappedGenerateKeyPair = Meteor.wrapAsync(this.forge.pki.rsa.generateKeyPair);

  // I could pick an `e`[xponent] value for the resulting RSA key, but
  // I will refrain.
  var keys = wrappedGenerateKeyPair({bits: 2048});

  // Create a certificate request (CSR).
  var csr = this.forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{
    name: 'commonName',
    value: commonName
  }]);
  csr.sign(keys.privateKey);
  console.log("generateKeyAndCsr created new key & certificate request for", commonName);
  return {privateKeyAsPem: this.forge.pki.privateKeyToPem(keys.privateKey),
          csrAsPem: this.forge.pki.certificationRequestToPem(csr)};
};

Sandcats.storeNewKeyAndCsr = function(hostname, basePath) {
  // We use the current JS time (like UNIX timestamp but in
  // milliseconds) as the key number. Note that the keyNumber is
  // intended to be an opaque identifier; the only important thing is
  // that it increases numerically over time. We use the current time
  // just as a simplistic way to pick a filename that probably no one
  // else has created yet.
  var keyNumber = new Date().getTime();
  var keyFilename = basePath + "/" + keyNumber;
  var csrFilename = keyFilename + ".csr";
  var responseFilename = keyFilename + ".response-json";
  var keyAndCsr = generateKeyAndCsr(hostname);
  fs.writeFileSync(keyFilename, keyAndCsr.privateKeyAsPem,
                   {'mode': 0400});
  fs.writeFileSync(csrFilename, keyAndCsr.csrAsPem);
  console.log("storeNewKeyAndCsr successfully saved key and certificate request to",
              keyFilename, "and", csrFilename, "respectively of length",
              keyAndCsr.privateKeyAsPem.length, "and",
              keyAndCsr.csrAsPem.length);
  return {csrFilename: csrFilename,
          keyFilename: keyFilename,
          responseFilename: responseFilename};
}

Sandcats.renewHttpsCertificateIfNeeded = function() {
  function renewHttpsCertificate() {
    var hostname = Url.parse(process.env.ROOT_URL).hostname;
    var basePath = '/var/sandcats/https/' + (
      hostname);
    var filenames = Sandcats.storeNewKeyAndCsr(hostname, basePath);

    var errorCallback = function (err) {
      console.error("Error while renewing HTTPS certificate (will continue to retry)", err);
    };

    var responseCallback = function (res) {
      if (res.statusCode == 200) {
        // Save the response, chunk by chunk, then store it on disk
        // for later use.
        var responseBody = "";
        res.on('data', function (chunk) {
          responseBody += chunk;
        });
        res.on('end', function() {
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

          fs.writeFile(filenames.responseFilename, responseBody, function(err) {
            if (err) {
              return console.error("Failure while saveing new HTTPS certificate to",
                                   filenames.responseFilename,
                                   "will continue to retry. Exception was:",
                                   err);
            }
          });

          // Tell Sandcats that now is a good time to update its info
          // about which keys are available.
          if (! global.sandcats) {
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
        res.on('data', function (chunk) {
          console.log("Error response contained information", chunk.toString('utf-8'));
        });
      }
    };

    var wrappedReadFile = Meteor.wrapAsync(fs.readFile);

    performSandcatsRequest("/getcertificate", SANDCATS_HOSTNAME, {
      rawHostname: SANDCATS_NAME,
      certificateSigningRequest: wrappedReadFile(filenames.csrFilename, 'utf-8')
    }, errorCallback, responseCallback);
  }

  // We only want to fetch a new certificate if such an action is
  // needed. The strategy is that if we're on a certificate right now,
  // and there is no nextRekeyTime available, then we should get a
  // fresh cert.
  if (global.sandcats.hasNextRekeyTime()) {
    return;
  } else {
    console.log("renewHttpsCertificateIfNeeded: Happily choosing to renew certificate because we found no rekey time.");
    return renewHttpsCertificate();
  }
}

Sandcats.initializeSandcats = function() {
  var i = HOSTNAME.lastIndexOf(SANDCATS_HOSTNAME);
  if (i < 0) {
    console.error("SANDCATS_BASE_DOMAIN is configured but your HOSTNAME doesn't appear to contain it:",
                  SANDCATS_HOSTNAME, HOSTNAME);
  } else {
    var oneMinute = 60 * 1000;
    var oneHour = 60 * oneMinute;
    var randomIntervalZeroToOneHour = Math.random() * oneHour;
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
}

if (SANDCATS_HOSTNAME) {
  Meteor.startup(Sandcats.initializeSandcats);
};
