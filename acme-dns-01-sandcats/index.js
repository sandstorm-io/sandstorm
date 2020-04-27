'use strict';

import https from "https";
import querystring from "querystring";
import dns from "dns";

class Challenge {
  constructor(options) {
    this.key = options.key;
    this.cert = options.cert;
    this.hostname = options.hostname;
    this.bindIp = options.bindIp;
    this.isTest = options.isTest;

    // Set `propagationDelay` for ACME.js.
    //
    // The DNS entries should be immediately available... unless it happens that someone had just
    // queried them before they were modified, in which case they could be cached for 60-90
    // seconds, but that's unusual and we don't want to wait that long every time we issue a cert.
    this.propagationDelay = 0;
  }

  async init({request}) {
    return null;
  }

  async zones({dnsHosts}) {
    return [this.hostname + ".sandcats.io"];
  }

  async set({challenge: {dnsAuthorization, dnsHost}}) {
    if (dnsHost != "_acme-challenge." + this.hostname + ".sandcats.io") {
      throw new Error("Can only set records for _acme-challenge, not: " + dnsHost);
    }

    return this._request({
      rawHostname: this.hostname,
      value: dnsAuthorization
    });
  }

  async get({challenge: {dnsAuthorization, dnsHost}}) {
    if (this.isTest) {
      // The test driver tends to run into problems with caching that don't appear in real-world
      // usage.
      console.log("waiting 30 seconds for propagation");
      await new Promise(resolve => setTimeout(resolve, 30000));
    }

    if (dnsHost != "_acme-challenge." + this.hostname + ".sandcats.io") {
      throw new Error("Can only set records for _acme-challenge, not: " + dnsHost);
    }

    let results = await new Promise((resolve, reject) => {
      dns.resolveTxt("_acme-challenge." + this.hostname + ".sandcats.io", (err, result) => {
        if (err) {
          if (err.code == dns.NOTFOUND || err.code == dns.NODATA) {
            resolve([]);
          } else {
            reject(err);
          }
        } else {
          resolve(result);
        }
      });
    });

    let records = results.map(chunks => chunks.join(""));
    let match = records.filter(record => record === dnsAuthorization);
    if (match[0]) {
      return {dnsAuthorization: match[0]};
    } else {
      return null;
    }
  }

  async remove() {
    // HACK: We always remove all challenges when asked to remove anything, because in practice
    //   ACME.js only calls remove() when it's time to remove everything, and I didn't want to
    //   build an API for removing individual challenges.
    return this._request({
      rawHostname: this.hostname
    });
  }

  async _request(postData) {
    let options = {
      hostname: "sandcats.io",
      path: "/acme-challenge",
      method: "POST",
      agent: false,
      key: this.key,
      cert: this.cert,
      headers: {
        "X-Sand": "cats",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };

    if (this.bindIp) {
      options.localAddress = this.bindIp;
    }

    let postDataString = querystring.stringify(postData);

    let response = await new Promise((resolve, reject) => {
      const req = https.request(options, resolve);
      req.write(postDataString);
      req.end();
      req.on("error", reject);
    });

    let responseBody = "";
    response.on("data", chunk => { responseBody += chunk; });
    await new Promise((resolve, reject) => {
      response.on("end", resolve);
      response.on("error", reject);
    });

    if (response.statusCode != 200) {
      throw new Error("sandcats request failed: " + response.statusCode + ": " + responseBody);
    }

    return null;
  }
};

export function create(options) {
  return new Challenge(options);
}
