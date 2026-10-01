"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const plugin = require("./index");

function fixture(initialValues = []) {
  let values = initialValues.slice();
  const changes = [];

  function change(operation) {
    changes.push(operation);
    return { metadata: { id: String(changes.length), status: "done" } };
  }

  const zone = {
    async getMetadata() {
      return [{ dnsName: "example.com." }];
    },
    async getRecords() {
      if (values.length === 0) return [[]];
      return [[{
        data: values.map((value) => `"${value}"`),
        async delete() {
          values = [];
          return [change("delete")];
        },
      }]];
    },
    record(_type, options) {
      return options;
    },
    async addRecords(record) {
      values = record.data.slice();
      return [change("add")];
    },
  };
  const dns = { zone: () => zone };
  const challenge = {
    dnsHost: "_acme-challenge.example.com",
    dnsAuthorization: "new-token",
  };

  return {
    challenge,
    changes,
    getValues: () => values,
    subject: plugin.create({ dns, zonename: "example" }),
  };
}

test("reports the configured DNS zone", async () => {
  const { subject } = fixture();
  assert.deepEqual(await subject.zones(), ["example.com"]);
});

test("adds a challenge without losing an existing TXT value", async () => {
  const state = fixture(["existing-token"]);
  await state.subject.set({ challenge: state.challenge });
  assert.deepEqual(state.getValues(), ["existing-token", "new-token"]);
  assert.deepEqual(state.changes, ["delete", "add"]);
});

test("does not rewrite an already-present challenge", async () => {
  const state = fixture(["new-token"]);
  assert.equal(await state.subject.set({ challenge: state.challenge }), null);
  assert.deepEqual(state.changes, []);
});

test("removes only the requested challenge", async () => {
  const state = fixture(["existing-token", "new-token"]);
  assert.equal(await state.subject.remove({ challenge: state.challenge }), true);
  assert.deepEqual(state.getValues(), ["existing-token"]);
  assert.deepEqual(state.changes, ["delete", "add"]);
});
