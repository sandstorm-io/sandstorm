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

var v8capnp = require("sandstorm/v8capnp");
var Promise = require("es6-promise").Promise;
var path = require("path");
var fs = require("fs");

var importPath = [];
for (var i in module.paths) {
  importPath.push(module.paths[i]);
}

if ("NODE_PATH" in process.env) {
  var parts = process.env.NODE_PATH.split(path.delimiter);
  for (var j in parts) {
    importPath.push(parts[j]);
  }
}

exports.import = function (filename) {
  for (var i in importPath) {
    var candidate = path.join(importPath[i], filename);
    if (fs.existsSync(candidate)) {
      return v8capnp.import(filename, candidate, importPath);
    }
  }
  throw new Error("Cap'n Proto schema not found in module path: " + filename);
}

function makeRemotePromise(promise, pipeline) {
  for (member in pipeline) {
    promise[member] = pipeline[member];
  }

  promise.cancel = function () {
    v8capnp.cancel(pipeline);
    closeAll(pipeline);
    promise.then(function (response) {
      closeAll(response);
    });
  }
}

function closeAll(obj) {
  for (var name in obj) {
    var member = obj[name];
    if (member instanceof Capability) {
      member.close();
    } else {
      closeAll(member);
    }
  }
}

function settleCaps(pipeline, final) {
  for (var name in pipeline) {
    var pmember = pipeline[name];

    if (name in final) {
      var fmember = final[name];

      if (pmember instanceof Capability) {
        // If pipelined capability was closed, close the final cap.
        // Otherwise, overwrite the pipelined cap with the final cap.
        if (pmember.closed) {
          fmember.close();
        } else {
          v8capnp.dup2(fmember, pmember);
        }
      } else {
        // Recurse into struct.
        settleCaps(pmember, fmember);
      }
    } else {
      if (pmember instanceof Capability) {
        pmember.close();
      } else {
        settleCaps(pmember, {});
      }
    }
  }
}

function makeMethod(cap, method) {
  return function () {
    var req = v8capnp.request(cap, method);
    v8capnp.fromJs(req, Array.prototype.slice.call(arguments, 0), LocalCapWrapper);
    var pipeline;
    var promise = new Promise(function (resolve, reject) {
      pipeline = v8capnp.send(req, resolve, reject, Capability);
    }).then(function (response) {
      var result = v8capnp.toJs(response, Capability);
      settleCaps(pipeline, result);
      return result;
    });
    makeRemotePromise(promise, pipeline);
    return promise;
  }
}

function wrapLocalMethod(self, method) {
  return function (request) {
    var params = v8capnp.toJsParams(request, Capability);
    v8capnp.releaseParams(request);
    Promise.cast(method.apply(self, params)).then(function (results) {
      if (typeof results !== "object") {
        if (results === undefined) {
          results = [];
        } else {
          // Wrap single primitive return value in an array.
          results = [results];
        }
      }
      v8capnp.fromJs(v8capnp.getResults(request), results, LocalCapWrapper);
      v8capnp.return_(request);
    }).catch(function (error) {
      v8capnp.throw_(request, error);
    }).catch(function (error) {
      console.error("Cap'n Proto v8 bug when returning from incoming method call:", error);
    });
  }
}

function LocalCapWrapper(obj) {
  for (var name in obj) {
    var method = obj[name];
    if (typeof method === "function") {
      this[name] = wrapLocalMethod(obj, method);
    }
  }
}

function Capability(native, schema) {
  // If `native` is actually a local object, wrap it as a capability.
  if (!v8capnp.isCap(native)) {
    native = v8capnp.newCap(schema, new LocalCapWrapper(native));
  }

  v8capnp.setNative(this, native);

  var methods = v8capnp.methods(schema);

  for (var name in methods) {
    this[name] = makeMethod(native, methods[name]);
  }

  this.close = function () { v8capnp.close(native); this.closed = true; }
  this.closed = false;
  this.clone = function () { return new Capability(v8capnp.dup(native), schema); }
  this.castAs = function (newSchema) {
    return new Capability(v8capnp.castAs(native, newSchema), newSchema);
  }
  this.schema = schema;

  Object.freeze(this);
}

function Connection(native) {
  this.restore = function (objectId, schema) {
    return new Capability(v8capnp.restore(native, objectId, schema), schema);
  }

  this.close = function () {
    v8capnp.disconnect(native);
  }
}

exports.connect = function (addr) {
  return new Connection(v8capnp.connect(addr));
}

exports.parse = function (schema, buffer) {
  var reader = v8capnp.fromBytes(buffer, schema);
  return v8capnp.toJs(reader, Capability);
}

exports.serialize = function (schema, value) {
  var builder = v8capnp.newBuilder(schema);
  v8capnp.fromJs(builder, value, LocalCapWrapper);
  return v8capnp.toBytes(builder);
}

exports.Capability = Capability;
