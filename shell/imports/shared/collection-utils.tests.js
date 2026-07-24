
import chai from "chai";

import {
  countBy,
  deepEqual,
  difference,
  findWhere,
  groupBy,
  indexBy,
  omit,
  pick,
  sortBy,
  throttle,
  unique,
  where,
} from "/imports/shared/collection-utils";

const { assert } = chai;

describe("Underscore replacement helpers", function () {
  it("preserves property matching and inherited pick/omit behavior", function () {
    const prototype = { inherited: 1 };
    const value = Object.assign(Object.create(prototype), { own: 2, kind: "match" });

    assert.strictEqual(findWhere([value], { kind: "match" }), value);
    assert.deepEqual(where([value, { kind: "other" }], { kind: "match" }), [value]);
    assert.deepEqual(pick(value, "inherited", "missing"), { inherited: 1 });
    assert.deepEqual(omit(value, "own", "kind"), { inherited: 1 });
  });

  it("groups, indexes, and counts without changing input order", function () {
    const values = [
      { id: "first", kind: "a" },
      { id: "second", kind: "b" },
      { id: "last", kind: "a" },
    ];

    assert.deepEqual(groupBy(values, "kind"), {
      a: [values[0], values[2]],
      b: [values[1]],
    });
    assert.deepEqual(indexBy(values, "kind"), { a: values[2], b: values[1] });
    assert.deepEqual(countBy(values, "kind"), { a: 2, b: 1 });
  });

  it("sorts stably and places undefined criteria last", function () {
    const values = [
      { id: "first", rank: 1 },
      { id: "undefined" },
      { id: "second", rank: 1 },
      { id: "zero", rank: 0 },
    ];

    assert.deepEqual(sortBy(values, "rank").map(value => value.id),
      ["zero", "first", "second", "undefined"]);
  });

  it("uses strict-equality set semantics, including historical NaN behavior", function () {
    const nan = Number.NaN;
    assert.deepEqual(difference([1, 2, 1, nan], [2, nan]), [1, 1, nan]);
    const distinct = unique([1, 1, nan, nan, 2]);
    assert.strictEqual(distinct.length, 4);
    assert.isTrue(Number.isNaN(distinct[1]));
    assert.isTrue(Number.isNaN(distinct[2]));
  });

  it("uses EJSON equality for dates and nested values", function () {
    assert.isTrue(deepEqual(
      { when: new Date(123), nested: [1, { ok: true }] },
      { when: new Date(123), nested: [1, { ok: true }] },
    ));
  });

  it("throttles on the leading and trailing edges", async function () {
    const calls = [];
    const throttled = throttle(value => calls.push(value), 30);
    throttled("leading");
    throttled("superseded");
    throttled("trailing");
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(calls, ["leading", "trailing"]);
  });
});
