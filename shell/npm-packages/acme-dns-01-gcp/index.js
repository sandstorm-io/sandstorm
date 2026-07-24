"use strict";

// Derived from acme-dns-01-gcp 0.0.10 by Renzo Tomlinson and contributors,
// with modifications by Sandstorm contributors.
// See README.md and LICENSE for attribution and licensing.

const fs = require("fs");
const { DNS } = require("@google-cloud/dns");

const CHANGE_ATTEMPTS = 10;
const CHANGE_POLL_MS = 5000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unquoteTxt(value) {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1);
  }

  return value;
}

async function waitForChange(change, operation) {
  let metadata = change.metadata;
  for (let attempt = 0; metadata.status !== "done"; attempt += 1) {
    if (attempt >= CHANGE_ATTEMPTS) {
      throw new Error(`Timed out waiting for Google Cloud DNS ${operation}.`);
    }

    await sleep(CHANGE_POLL_MS);
    [metadata] = await change.getMetadata();
  }

  return metadata;
}

module.exports.create = function create(config) {
  const credentials = typeof config.credentials === "string"
    ? JSON.parse(fs.readFileSync(config.credentials, "utf8"))
    : config.credentials;
  const dns = config.dns || new DNS({ projectId: config.projectId, credentials });
  const zone = dns.zone(config.zonename);
  const locks = new Map();

  async function withHostnameLock(hostname, operation) {
    const previous = locks.get(hostname) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    locks.set(hostname, queued);
    await previous;

    try {
      return await operation();
    } finally {
      release();
      if (locks.get(hostname) === queued) locks.delete(hostname);
    }
  }

  async function findTxtRecord(name) {
    const [records] = await zone.getRecords({ name, type: "TXT" });
    return records[0];
  }

  async function deleteRecord(record) {
    const [change] = await record.delete();
    await waitForChange(change, "record deletion");
  }

  async function addRecord(name, values) {
    const record = zone.record("txt", { name, ttl: 300, data: values });
    const [change] = await zone.addRecords(record);
    await waitForChange(change, "record update");
    return change.metadata.id;
  }

  return {
    propagationDelay: config.propagationDelay || 5000,

    async init() {
      return null;
    },

    async zones() {
      const [metadata] = await zone.getMetadata();
      return [metadata.dnsName.replace(/\.$/, "")];
    },

    async set({ challenge }) {
      const recordName = `${challenge.dnsHost}.`;
      return withHostnameLock(recordName, async () => {
        const existing = await findTxtRecord(recordName);
        const values = existing ? existing.data.map(unquoteTxt) : [];
        if (values.includes(challenge.dnsAuthorization)) return null;
        if (existing) await deleteRecord(existing);
        return addRecord(recordName, values.concat(challenge.dnsAuthorization));
      });
    },

    async get({ challenge }) {
      const recordName = `${challenge.dnsHost}.`;
      const existing = await findTxtRecord(recordName);
      if (!existing) return null;
      const found = existing.data.map(unquoteTxt).includes(challenge.dnsAuthorization);
      return found ? { dnsAuthorization: challenge.dnsAuthorization } : null;
    },

    async remove({ challenge }) {
      const recordName = `${challenge.dnsHost}.`;
      return withHostnameLock(recordName, async () => {
        const existing = await findTxtRecord(recordName);
        if (!existing) return null;

        const values = existing.data.map(unquoteTxt);
        if (!values.includes(challenge.dnsAuthorization)) return null;

        await deleteRecord(existing);
        const remaining = values.filter((value) => value !== challenge.dnsAuthorization);
        if (remaining.length > 0) await addRecord(recordName, remaining);
        return true;
      });
    },
  };
};
