/* eslint-env mocha */

import assert from "assert";
import { LoginRendezvous } from "./rendezvous";

const makeError = (code, message) => Object.assign(new Error(message), { code });

describe("accounts-sandstorm rendezvous", function () {
  it("resolves once and cleans up", async function () {
    const rendezvous = new LoginRendezvous({ maxPending: 2, timeoutMs: 100, makeError });
    const waiting = rendezvous.wait("token");
    assert.strictEqual(rendezvous.size, 1);
    assert.strictEqual(rendezvous.resolve("token", { user: "alice" }), true);
    assert.strictEqual(rendezvous.resolve("token", { user: "mallory" }), false);
    assert.deepStrictEqual(await waiting, { user: "alice" });
    assert.strictEqual(rendezvous.size, 0);
  });

  it("bounds pending logins and cleans up timeouts", async function () {
    const rendezvous = new LoginRendezvous({ maxPending: 1, timeoutMs: 20, makeError });
    const waiting = rendezvous.wait("first");
    assert.throws(() => rendezvous.wait("second"), /Too many/);
    await assert.rejects(waiting, error => error.code === "timeout");
    assert.strictEqual(rendezvous.size, 0);
  });
});
