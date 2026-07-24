/* eslint-env mocha */

import chai from "chai";
import Url from "url";

import {
  parseCidr,
  redirectedRequest,
  selectSafeAddress,
} from "/imports/server/networking";

const { assert } = chai;

describe("Fetch networking security", function () {
  it("matches IPv4 and IPv6 CIDRs", function () {
    assert.isTrue(parseCidr("10.0.0.0/8")("10.2.3.4"));
    assert.isFalse(parseCidr("10.0.0.0/8")("11.2.3.4"));
    assert.isTrue(parseCidr("2001:db8::/32")("2001:db8::42"));
    assert.isFalse(parseCidr("2001:db8::/32")("2001:db9::42"));
  });

  it("rejects reserved and administrator-blocked addresses", async function () {
    const db = { getSettingAsync: async () => "203.0.113.0/24" };
    const parsed = Url.parse("https://example.test/path");
    try {
      await selectSafeAddress(db, parsed, [
        { address: "127.0.0.1", family: 4 },
        { address: "203.0.113.4", family: 4 },
      ]);
      assert.fail("Expected all blocked addresses to be rejected.");
    } catch (error) {
      assert.match(error.message, /blacklisted private network address/);
    }
  });

  it("applies Fetch redirect methods and strips cross-origin credentials", function () {
    const headers = new Headers({
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "Content-Type": "application/json",
    });
    const response = new Response(null, {
      status: 302,
      headers: { Location: "https://other.example/next" },
    });
    const redirect = redirectedRequest(
      response,
      "https://origin.example/start",
      "POST",
      headers,
      "{}",
    );

    assert.strictEqual(redirect.method, "GET");
    assert.isUndefined(redirect.body);
    assert.isFalse(redirect.headers.has("authorization"));
    assert.isFalse(redirect.headers.has("cookie"));
    assert.isFalse(redirect.headers.has("content-type"));
  });

  it("preserves methods and bodies across 307 redirects", function () {
    const response = new Response(null, {
      status: 307,
      headers: { Location: "/next" },
    });
    const redirect = redirectedRequest(
      response,
      "https://origin.example/start",
      "PUT",
      new Headers(),
      "body",
    );

    assert.strictEqual(redirect.url, "https://origin.example/next");
    assert.strictEqual(redirect.method, "PUT");
    assert.strictEqual(redirect.body, "body");
  });
});
