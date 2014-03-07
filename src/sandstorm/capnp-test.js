// Hacky node.js bindings for Cap'n Proto.
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// This file is part of the Sandstorm API, which is licensed as follows.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this
//    list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
// ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

var fs = require("fs");
var capnp = require("sandstorm/capnp");
var v8capnp = require("sandstorm/v8capnp");
var assert = require("assert");
var Fiber = require("fibers");
var Promise = require("es6-promise").Promise;
var spawn = require("child_process").spawn;

function wait(promise) {
  var fiber = Fiber.current;
  var success, result, error;
  promise.then(function (p) {
    success = true;
    result = p;
    fiber.run();
  }, function (e) {
    success = false;
    error = e;
    fiber.run();
  });
  Fiber.yield();
  if (success) {
    return result;
  } else {
    throw error;
  }
}

function doFiber(func, child) {
  new Fiber(function () {
    try {
      func();
      if (child) {
        child.kill();
        child.unref();
      }
    } catch (err) {
      console.log(err.stack);
      if (child) {
        child.kill();
        child.unref();
      }
      process.exit(1);
    }
  }).run();
}

var goldenBinary = fs.readFileSync("capnp/testdata/binary");

var test = capnp.import("capnp/test.capnp");
var parsed = capnp.parse(test.TestAllTypes, goldenBinary);

var roundTripped = capnp.serialize(test.TestAllTypes, parsed);

function canonicalize(schema, buf) {
  var reader = v8capnp.fromBytes(buf, schema);
  var builder = v8capnp.copyBuilder(reader);
  return v8capnp.toBytes(builder);
}

var canon = canonicalize(test.TestAllTypes, roundTripped);

assert.equal(goldenBinary.length, roundTripped.length, "Round trip changed size?");
assert.equal(goldenBinary.toString("base64"), canon.toString("base64"), "Round trip lost data?");

// =======================================================================================

var child = spawn("capnp-samples/calculator-server", ["127.0.0.1:21311"],
                  {stdio: [0, "pipe", 2], env: {}});

child.stdio[1].once("readable", function() {
  child.stdio[1].resume();  // ignore all input

  doFiber(function() {
    var conn = capnp.connect("127.0.0.1:21311");
    var Calculator = capnp.import("capnp-samples/calculator.capnp").Calculator;
    var calc = conn.restore("calculator", Calculator);

    var add = calc.getOperator("add").func;
    var subtract = calc.getOperator("subtract").func;
    var pow = {
      call: function (params) {
        return Math.pow(params[0], params[1]);
      }
    };

    var localCap = new capnp.Capability(pow, Calculator.Function);
    assert.equal(9, wait(localCap.call([3, 2])).value);
    localCap.close();

    var promise = calc.evaluate(
        {call: {"function": subtract, params: [
            {call: {"function": add, params: [
                {literal: 123}, {literal: 456}]}},
            {literal: 321}]}});

    var value = promise.value;
    assert.equal(258, wait(value.read()).value);
    value.close();

    value = calc.evaluate(
        {call: {"function": pow, params: [{literal: 2}, {literal: 4}]}}).value;
    assert.equal(16, wait(value.read()).value);
    value.close();

    add.close();
    subtract.close();
    conn.close();
  }, child);
});
