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

var Crypto = Npm.require("crypto");
var ChildProcess = Npm.require("child_process");
var Fs = Npm.require("fs");
var Path = Npm.require("path");
var Future = Npm.require("fibers/future");
var Http = Npm.require("http");

var ByteStream = Capnp.importSystem("sandstorm/util.capnp").ByteStream;
var WebSession = Capnp.importSystem("sandstorm/web-session.capnp").WebSession;
var HackSession = Capnp.importSystem("sandstorm/hack-session.capnp");
var Supervisor = Capnp.importSystem("sandstorm/supervisor.capnp").Supervisor;

var SANDSTORM_ALTHOME = Meteor.settings && Meteor.settings.home;
SANDSTORM_VARDIR = (SANDSTORM_ALTHOME || "") + "/var/sandstorm";
SANDSTORM_APPDIR = SANDSTORM_VARDIR + "/apps";
SANDSTORM_GRAINDIR = SANDSTORM_VARDIR + "/grains";
SANDSTORM_DOWNLOADDIR = SANDSTORM_VARDIR + "/downloads";

sandstormExe = function (progname) {
  if (SANDSTORM_ALTHOME) {
    return SANDSTORM_ALTHOME + "/latest/bin/" + progname;
  } else {
    return progname;
  }
}

// =======================================================================================
// Meteor context <-> Async Node.js context adapters
// TODO(cleanup):  Move to a different file.

var inMeteorInternal = Meteor.bindEnvironment(function (callback) {
  callback();
});

inMeteor = function (callback) {
  // Calls the callback in a Meteor context.  Returns a Promise for its result.
  return new Promise(function (resolve, reject) {
    inMeteorInternal(function () {
      try {
        resolve(callback());
      } catch (err) {
        reject(err);
      }
    });
  });
}

promiseToFuture = function(promise) {
  var result = new Future();
  promise.then(result.return.bind(result), result.throw.bind(result));
  return result;
}

function waitPromise(promise) {
  return promiseToFuture(promise).wait();
}

// =======================================================================================
// API for creating / starting grains from Meteor methods.

var runningGrains = {};
var proxies = {};
var proxiesByHostId = {};

Meteor.methods({
  newGrain: function (packageId, command, title) {
    // Create and start a new grain.

    if (!this.userId) {
      throw new Meteor.Error(403, "Unauthorized", "Must be logged in to create grains.");
    }

    var package = Packages.findOne(packageId);
    var appId;
    var manifest;
    var isDev = false;
    if (package) {
      appId = package.appId;
      manifest = package.manifest;
    } else {
      var devApp = DevApps.findOne({packageId: packageId});
      if (devApp) {
        appId = devApp._id;
        manifest = devApp.manifest;
        isDev = true;
      } else {
        throw new Meteor.Error(404, "Not Found", "No such package is installed.");
      }
    }

    var grainId = Random.id(22);  // 128 bits of entropy
    Grains.insert({
      _id: grainId,
      packageId: packageId,
      appId: appId,
      appVersion: manifest.appVersion,
      userId: this.userId,
      title: title
    });
    startGrainInternal(packageId, grainId, this.userId, command, true, isDev);
    updateLastActive(grainId, Meteor.userId());
    return grainId;
  },

  openSession: function (grainId) {
    // Open a new UI session on an existing grain.  Starts the grain if it is not already
    // running.

    check(grainId, String);

    var sessionId = Random.id();
    var user = Meteor.user();
    var userId = user ? user._id : undefined;

    // Start the grain if it is not running.
    var runningGrain = runningGrains[grainId];
    var grainInfo;
    if (runningGrain) {
      grainInfo = waitPromise(runningGrain);
    } else {
      grainInfo = continueGrain(grainId);
    }

    updateLastActive(grainId, userId);

    var isOwner = grainInfo.owner === userId;

    var proxy = new Proxy(grainId, sessionId, null, isOwner, user);
    proxies[sessionId] = proxy;
    proxiesByHostId[proxy.hostId] = proxy;

    Sessions.insert({
      _id: sessionId,
      grainId: grainId,
      hostId: proxy.hostId,
      timestamp: new Date().getTime(),
      userId: userId
    });

    return {sessionId: sessionId, hostId: proxy.hostId};
  },

  keepSessionAlive: function (sessionId) {
    // TODO(security):  Prevent draining someone else's quota by holding open several grains shared
    //   by them.
    if (sessionId in proxies) {
      Sessions.update(sessionId, {$set: {timestamp: new Date().getTime()}});
      var proxy = proxies[sessionId];
      var future = promiseToFuture(proxy.keepAlive());
      updateLastActive(proxy.grainId, this.userId);
      future.wait();
      return true;
    } else {
      return false;
    }
  },

  shutdownGrain: function (grainId) {
    check(grainId, String);
    var grain = Grains.findOne(grainId);
    if (!grain || !this.userId || grain.userId !== this.userId) {
      throw new Meteor.Error(403, "Unauthorized", "User is not the owner of this grain");
    }

    waitPromise(shutdownGrain(grainId, true));
  }
});

function updateLastActive(grainId, userId) {
  var now = new Date();
  Grains.update(grainId, {$set: {lastUsed: now}});
  if (userId) {
    Meteor.users.update(userId, {$set: {lastActive: now}});
  }
}

function connectToGrain(grainId) {
  return Capnp.connect("unix:" +
      Path.join(SANDSTORM_GRAINDIR, grainId, "socket"));
}

openGrain = function (grainId, isRetry) {
  // Create a Cap'n Proto connection to the given grain. Note that this function does not actually
  // verify that the connection succeeded. Instead, if an RPC call to the connection fails, check
  // shouldRestartGrain(). If it returns true, call continueGrain() and then openGrain()
  // again with isRetry = true, and then retry.

  if (isRetry) {
    // Since this is a retry, try starting the grain even if we think it's already running.
    continueGrain(grainId);
  } else {
    // Start the grain if it is not running.
    var runningGrain = runningGrains[grainId];
    if (runningGrain) {
      waitPromise(runningGrain);
    } else {
      continueGrain(grainId);
    }
  }

  return connectToGrain(grainId);
}

shouldRestartGrain = function (error, retryCount) {
  // Given an error thrown by an RPC call to a grain, return whether or not it makes sense to try
  // to restart the grain and retry. `retryCount` is the number of times that the request has
  // already gone through this cycle (should be zero for the first call).

  // TODO(cleanup): We also have to try on osError to catch the case where connecting to the
  //   socket failed. We really ought to find a more robust way to detect that, though.
  return "nature" in error &&
      (error.nature === "networkFailure" || error.nature === "osError") &&
      retryCount < 1;
}

function continueGrain(grainId) {
  var grain = Grains.findOne(grainId);
  if (!grain) {
    throw new Meteor.Error(404, "Grain Not Found", "Grain ID: " + grainId);
  }

  var manifest;
  var packageId;
  var devApp = DevApps.findOne({_id: grain.appId});
  var isDev;
  if (devApp) {
    // If a DevApp with the same app ID is currently active, we let it override the installed
    // package, so that the grain runs using the dev app.
    manifest = devApp.manifest;
    packageId = devApp.packageId;
    isDev = true;
  } else {
    var pkg = Packages.findOne(grain.packageId);
    if (pkg) {
      manifest = pkg.manifest;
      packageId = pkg._id;
    } else {
      throw new Meteor.Error(500, "Grain's package not installed",
                             "Package ID: " + grain.packageId);
    }
  }

  if (!("continueCommand" in manifest)) {
    throw new Meteor.Error(500, "Package manifest defines no continueCommand.",
                           "Package ID: " + packageId);
  }

  return startGrainInternal(
      packageId, grainId, grain.userId, manifest.continueCommand, false, isDev);
}

function startGrainInternal(packageId, grainId, ownerId, command, isNew, isDev) {
  // Starts the grain supervisor.  Must be executed in a Meteor context.  Blocks until grain is
  // started.

  var args = [];

  // If we're running outside of the Sandstorm server namespace (e.g. because we're running in
  // Meteor dev mode), we'll need to invoke "sandstorm supervise" rather than invoke the supervisor
  // directly.
  var exe;
  if (SANDSTORM_ALTHOME) {
    exe = SANDSTORM_ALTHOME + "/sandstorm";
    args.push("supervise");
    args.push("--");
  } else {
    exe = "/bin/sandstorm-supervisor";
  }

  args.push(packageId);
  args.push(grainId);
  if (isNew) args.push("-n");
  if (command.environ) {
    for (var i in command.environ) {
      args.push(["-e", command.environ[i].key, "=", command.environ[i].value].join(""));
    }
  }

  if (isDev) {
    // This just allows some debug syscalls that we disable in prod, especially ptrace.
    args.push("--dev");
  }

  args.push("--");

  // Ugly: Stay backwards-compatible with old manifests that had "executablePath" and "args" rather
  //   than just "argv".
  var exePath = command.deprecatedExecutablePath || command.executablePath;
  if (exePath) {
    args.push(exePath);
  }
  args = args.concat(command.argv || command.args);

  var proc = ChildProcess.spawn(exe, args, {
    stdio: ["ignore", "pipe", process.stderr],
    detached: true
  });
  proc.on("error", function (err) {
    console.error(err.stack);
    delete runningGrains[grainId];
  });
  proc.on("exit", function (code, sig) {
    if (code) {
      console.error("sandstorm-supervisor exited with code: " + code);
    } else if (sig) {
      console.error("sandstorm-supervisor killed by signal: " + sig);
    }

    delete runningGrains[grainId];
  });
  proc.unref();

  var whenReady = new Promise(function (resolve, reject) {
    proc.stdout.on("data", function (data) {
      // Data on stdout indicates that the grain is ready.
      resolve({owner: ownerId});
    });
    proc.on("error", function (err) {
      // Grain failed to start.
      reject(err);
    });
    proc.stdout.on("end", function () {
      // Grain exited without being ready.
      reject(new Error("Grain never came up."));
    });
  });

  runningGrains[grainId] = whenReady;
  return waitPromise(whenReady);
}

shutdownGrain = function (grainId, keepSessions) {
  if (!keepSessions) {
    Sessions.find({grainId: grainId}).forEach(function (session) {
      var proxy = proxies[session._id];
      if (proxy) {
        delete proxies[session._id];
        delete proxiesByHostId[session._id];
      }
      Sessions.remove(session._id);
    });
  }

  // Try to send a shutdown.  The grain may not be running, in which case this will fail, which
  // is fine.  In fact even if the grain is running, we expect the call to fail because the grain
  // kills itself before returning.
  var connection = Capnp.connect("unix:" + Path.join(SANDSTORM_GRAINDIR, grainId, "socket"));
  var supervisor = connection.restore(null, Supervisor);

  return supervisor.shutdown().then(function (result) {
    supervisor.close();
    connection.close();
  }, function (error) {
    supervisor.close();
    connection.close();
  });
}

deleteGrain = function (grainId) {
  shutdownGrain(grainId);
  // Give time to shut down before deleting.
  setTimeout(function () {
    var dir = Path.join(SANDSTORM_GRAINDIR, grainId);
    if (Fs.existsSync(dir)) {
      recursiveRmdir(dir);
    }
  }, 1000);
}

getGrainSize = function (sessionId, oldSize) {
  var proxy = proxies[sessionId];
  if (!proxy) {
    throw new Meteor.Error(500, "Session not running; can't get grain size.");
  }

  if (!proxy.supervisor) {
    proxy.getConnection();
  }

  var promise;
  if (oldSize === undefined) {
    promise = proxy.supervisor.getGrainSize();
  } else {
    promise = proxy.supervisor.getGrainSizeWhenDifferent(oldSize);
  }

  var promise2 = promise.then(function (result) { return parseInt(result.size); });
  promise2.cancel = function () { promise.cancel(); }

  return promise2;
}

// Kill off proxies idle for >~5 minutes.
var TIMEOUT_MS = 300000;
function gcSessions() {
  var now = new Date().getTime();
  Sessions.find({timestamp: {$lt: (now - TIMEOUT_MS)}}).forEach(function (session) {
    var proxy = proxies[session._id];
    if (proxy) {
      delete proxies[session._id];
      delete proxiesByHostId[session._id];
    }
    Sessions.remove(session._id);
  });
}
Meteor.setInterval(gcSessions, 60000);

// Try to restore sessions on server restart.
Meteor.startup(function () {
  // Delete stale sessions from session list.
  gcSessions();

  // Remake proxies for all sessions that remain.
  Sessions.find({}).forEach(function (session) {
    var grain = Grains.findOne(session.grainId);
    var user = Meteor.users.findOne({_id: session.userId});
    var isOwner = grain.userId === session.userId;
    var proxy = new Proxy(session.grainId, session._id, session.hostId, isOwner, user);
    proxies[session._id] = proxy;
    proxiesByHostId[session.hostId] = proxy;
  });
});

// =======================================================================================
// Routing to proxies.
//

tryProxyUpgrade = function (hostId, req, socket, head) {
  if (hostId in proxiesByHostId) {
    var proxy = proxiesByHostId[hostId]

    // Meteor sets the timeout to five seconds. Change that back to two
    // minutes, which is the default value.
    socket.setTimeout(120000);

    proxy.upgradeHandler(req, socket, head);
    return true;
  } else {
    return false;
  }
}

tryProxyRequest = function (hostId, req, res) {
  if (hostId in proxiesByHostId) {
    var proxy = proxiesByHostId[hostId];
    proxy.requestHandler(req, res);
    return true;
  } else {
    return false;
  }
}


// =======================================================================================
// Proxy class
//
// Connects to a grain and exports it on a wildcard host.
//

function Proxy(grainId, sessionId, preferredHostId, isOwner, user) {
  this.grainId = grainId;
  this.sessionId = sessionId;
  this.isOwner = isOwner;
  if (!preferredHostId) {
    this.hostId = generateRandomHostname(20);
  } else {
    this.hostId = preferredHostId;
  }

  if (user) {
    var serviceId;
    if (user.expires) {
      serviceId = "demo:" + user._id;
    } else if (user.services && user.services.google) {
      serviceId = "google:" + user.services.google.id;
    } else if (user.services && user.services.github) {
      serviceId = "github:" + user.services.github.id;
    } else {
      // Make sure that if we add a new user type we don't forget to update this.
      throw new Meteor.Error(500, "Unknown user type.");
    }
    this.userInfo = {
      displayName: {defaultText: user.profile.name},
      userId: Crypto.createHash("sha256").update(serviceId).digest()
    }
  } else {
    this.userInfo = {
      displayName: {defaultText: "Anonymous User"}
    }
  }

  var self = this;

  this.requestHandler = function (request, response) {
    if (request.url === "/_sandstorm-init?sessionid=" + self.sessionId) {
      self.doSessionInit(request, response);
      return;
    }

    readAll(request).then(function (data) {
      return self.handleRequest(request, data, response, 0);
    }).catch(function (err) {
      console.error(err.stack);
      var body = err.stack;
      if (err.cppFile) {
        body += "\nC++ location:" + err.cppFile + ":" + (err.line || "??");
      }
      if (err.nature || err.durability) {
        body += "\ntype: " + (err.durability || "") + " " + (err.nature || "(unknown)")
      }
      if (err instanceof Meteor.Error) {
        response.writeHead(err.error, err.reason, { "Content-Type": "text/plain" });
      } else {
        response.writeHead(500, "Internal Server Error", { "Content-Type": "text/plain" });
      }
      response.end(body);
    });
  };

  this.upgradeHandler = function (request, socket, head) {
    self.handleWebSocket(request, socket, head, 0).catch(function (err) {
      console.error("WebSocket setup failed:", err.stack);
      // TODO(cleanup):  Manually send back a 500 response?
      socket.destroy();
    });
  };

}

Proxy.prototype.getConnection = function () {
  // TODO(perf):  Several proxies could share a connection if opening the same grain in multiple
  //   tabs.  Each should be a separate session.
  if (!this.connection) {
    this.connection = connectToGrain(this.grainId);
    this.supervisor = this.connection.restore(null, Supervisor);
    this.uiView = this.supervisor.getMainView().view;
  }
  return this.connection;
}

var Url = Npm.require("url");
var PROTOCOL = Url.parse(process.env.ROOT_URL).protocol;

Proxy.prototype._callNewSession = function (request, viewInfo) {
  var params = Capnp.serialize(WebSession.Params, {
    basePath: PROTOCOL + "//" + request.headers.host,
    userAgent: "user-agent" in request.headers
        ? request.headers["user-agent"]
        : "UnknownAgent/0.0",
    acceptableLanguages: "accept-language" in request.headers
        ? request.headers["accept-language"].split(",").map(function (s) { return s.trim(); })
        : [ "en-US", "en" ]
  });

  var userInfo = _.clone(this.userInfo);
  if (viewInfo.permissions) {
    var numBytes = Math.ceil(viewInfo.permissions.length / 8);

    var buf = new Buffer(numBytes);
    for(var i = 0; i < numBytes; i++) {
      buf.writeUInt8(this.isOwner * 255, i);
    }

    userInfo.permissions = buf;
  }

  return this.uiView.newSession(userInfo, makeHackSessionContext(this.grainId),
    "0xa50711a14d35a8ce", params).session;
};

Proxy.prototype.getSession = function (request) {
  if (!this.session) {
    this.getConnection();  // make sure we're connected
    var self = this;
    var promise = this.uiView.getViewInfo().then(function (viewInfo) {
      return self._callNewSession(request, viewInfo);
    }, function (error) {
      // Assume method not implemented.
      // TODO(someday): Maybe we need a better way to detect method-not-implemented?
      return self._callNewSession(request, {});
    });
    this.session = new Capnp.Capability(promise, WebSession);
  }

  return this.session;
}

Proxy.prototype.keepAlive = function () {
  this.getConnection();
  return this.supervisor.keepAlive();
}

Proxy.prototype.resetConnection = function () {
  if (this.session) {
    this.session.close();
    delete this.session;
  }
  if (this.connection) {
    this.uiView.close();
    this.supervisor.close();
    this.connection.close();
    delete this.uiView;
    delete this.supervisor;
    delete this.connection;
  }
}

Proxy.prototype.maybeRetryAfterError = function (error, retryCount) {
  // If the error may be caused by the grain dying or a network failure, try to restart it,
  // returning a promise that resolves once restarted. Otherwise, just rethrow the error.
  // `retryCount` should be incremented for every successful retry as part of the same request;
  // we only want to retry once.

  var self = this;

  if (shouldRestartGrain(error, retryCount)) {
    this.resetConnection();
    return inMeteor(function () {
      continueGrain(self.grainId);
    });
  } else {
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Session cookie management

function parseCookies(request) {
  var header = request.headers["cookie"];

  var result = { cookies: [] };
  if (header) {
    var reqCookies = header.split(";");
    for (var i in reqCookies) {
      var reqCookie = reqCookies[i];
      var equalsPos = reqCookie.indexOf("=");
      var cookie;
      if (equalsPos === -1) {
        cookie = {key: reqCookie.trim(), value: ""};
      } else {
        cookie = {key: reqCookie.slice(0, equalsPos).trim(), value: reqCookie.slice(equalsPos + 1)};
      }

      if (cookie.key === "sandstorm-sid") {
        if (result.sessionId) {
          throw new Error("Multiple sandstorm session IDs?");
        }
        result.sessionId = cookie.value;
      } else {
        result.cookies.push(cookie);
      }
    }
  }

  return result;
}

function makeClearCookieHeader(cookie) {
  return cookie.key + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
}

Proxy.prototype.doSessionInit = function (request, response) {
  var parseResult = parseCookies(request);

  if (parseResult.sessionId !== this.sessionId) {
    // We need to set the session ID cookie and clear all other cookies.
    //
    // TODO(soon):  We ought to clear LocalStorage too, but that's complicated, and there may be
    //   still be other things.  Longer-term we need to use random hostnames as origins, but that's
    //   complicated for people running on localhost as they'd have to set up a DNS server just to
    //   configure a wildcard DNS.
    var setCookieHeaders = parseResult.cookies.map(makeClearCookieHeader);

    // Also set the session ID.
    setCookieHeaders.push(
        ["sandstorm-sid=", this.sessionId, "; Max-Age=31536000; HttpOnly"].join(""));

    response.setHeader("Set-Cookie", setCookieHeaders);
  }

  response.setHeader("Cache-Control", "no-cache, private");

  // Redirect to the app's root URL.
  // Note:  All browsers support relative locations and the next update to HTTP/1.1 will officially
  //   make them valid.  http://tools.ietf.org/html/draft-ietf-httpbis-p2-semantics-26#page-67
  response.writeHead(303, "See Other", { "Location": "/" });
  response.end();
}

Proxy.prototype.makeContext = function (request) {
  // Parses the cookies from the request, checks that the session ID is present and valid, then
  // returns the request context which contains the other cookies.  Throws an exception if the
  // session ID is missing or invalid.

  var parseResult = parseCookies(request);
  if (!parseResult.sessionId || parseResult.sessionId !== this.sessionId) {
    throw new Meteor.Error(403, "Unauthorized");
  }

  var context = {};
  if (parseResult.cookies.length > 0) {
    context.cookies = parseResult.cookies;
  }

  var promise = new Promise(function (resolve, reject) {
    request.resolveResponseStream = resolve;
    request.rejectResponseStream = reject;
  });

  context.responseStream = new Capnp.Capability(promise, ByteStream);

  return context;
}

// -----------------------------------------------------------------------------
// Regular HTTP request handling

function readAll(stream) {
  return new Promise(function (resolve, reject) {
    var buffers = [];
    var len = 0;
    stream.on("data", function (buf) {
      buffers.push(buf);
      len += buf.length;
    });
    stream.on("end", function () {
      resolve(Buffer.concat(buffers), len);
    });
    stream.on("error", reject);
  });
}

function makeSetCookieHeader(cookie) {
  var result = [cookie.name, "=", cookie.value];

  if ("absolute" in cookie.expires) {
    result.push("; Expires=");
    result.push(new Date(cookie.expires.absolute * 1000).toUTCString());
  } else if ("relative" in cookie.expires) {
    result.push("; Max-Age=" + cookie.expires.relative);
  }

  if (cookie.path) {
    result.push("; Path=" + cookie.path);
  }

  if (cookie.httpOnly) {
    result.push("; HttpOnly");
  }

  return result.join("");
}

// TODO(cleanup):  Auto-generate based on annotations in web-session.capnp.
var successCodes = {
  ok:       { id: 200, title: "OK" },
  created:  { id: 201, title: "Created" },
  accepted: { id: 202, title: "Accepted" }
};
var noContentSuccessCodes = [
  // Indexed by shouldResetForm * 1
  { id: 204, title: "No Content" },
  { id: 205, title: "Reset Content" }
];
var redirectCodes = [
  // Indexed by switchToGet * 2 + isPermanent
  { id: 307, title: "Temporary Redirect" },
  { id: 308, title: "Permanent Redirect" },
  { id: 303, title: "See Other" },
  { id: 301, title: "Moved Permanently" }
];
var errorCodes = {
  badRequest:            { id: 400, title: "Bad Request" },
  forbidden:             { id: 403, title: "Forbidden" },
  notFound:              { id: 404, title: "Not Found" },
  methodNotAllowed:      { id: 405, title: "Method Not Allowed" },
  notAcceptable:         { id: 406, title: "Not Acceptable" },
  conflict:              { id: 409, title: "Conflict" },
  gone:                  { id: 410, title: "Gone" },
  requestEntityTooLarge: { id: 413, title: "Request Entity Too Large" },
  requestUriTooLong:     { id: 414, title: "Request-URI Too Long" },
  unsupportedMediaType:  { id: 415, title: "Unsupported Media Type" },
  imATeapot:             { id: 418, title: "I'm a teapot" },
};

function ResponseStream(response, streamHandle) {
  this.response = response;
  this.streamHandle = streamHandle;
}

ResponseStream.prototype.write = function(data) {
  this.response.write(data);
}

ResponseStream.prototype.done = function() {
  this.response.end();
}

Proxy.prototype.handleRequest = function (request, data, response, retryCount) {
  var self = this;

  return Promise.resolve(undefined).then(function () {
    return self.makeContext(request);
  }).then(function (context) {
    // Send the RPC.
    var path = request.url.slice(1);  // remove leading '/'
    var session = self.getSession(request);

    if (request.method === "GET") {
      return session.get(path, context);
    } else if (request.method === "POST") {
      return session.post(path, {
        mimeType: request.headers["content-type"] || "application/octet-stream",
        content: data
      }, context);
    } else if (request.method === "PUT") {
      return session.put(path, {
        mimeType: request.headers["content-type"] || "application/octet-stream",
        content: data
      }, context);
    } else if (request.method === "DELETE") {
      return session.delete(path, context);
    } else {
      throw new Error("Sandstorm only supports GET, POST, PUT, and DELETE requests.");
    }

  }).then(function (rpcResponse) {
    // Translate the response.
    if (rpcResponse.setCookies && rpcResponse.setCookies.length > 0) {
      response.setHeader("Set-Cookie", rpcResponse.setCookies.map(makeSetCookieHeader));
    }

    if ("content" in rpcResponse) {
      var content = rpcResponse.content;
      var code = successCodes[content.statusCode];
      if (!code) {
        throw new Error("Unknown status code: ", content.statusCode);
      }

      if (content.mimeType) {
        response.setHeader("Content-Type", content.mimeType);
      }
      if (content.encoding) {
        response.setHeader("Content-Encoding", content.encoding);
      }
      if (content.language) {
        response.setHeader("Content-Language", content.language);
      }
      if ("stream" in content.body) {
        response.writeHead(code.id, code.title);
        request.resolveResponseStream(
          new Capnp.Capability(new ResponseStream(response, content.body.stream),
                               ByteStream));
        return;
      } else {
        request.rejectResponseStream(
          new Error("Response content body was not a stream."));

        if ("bytes" in content.body) {
          response.setHeader("Content-Length", content.body.bytes.length);
        } else {
          throw new Error("Unknown content body type.");
        }
      }
      if (("disposition" in content) && ("download" in content.disposition)) {
        response.setHeader("Content-Disposition", "attachment; filename=\"" +
            content.disposition.download.replace(/([\\"\n])/g, "\\$1") + "\"");
      }

      response.writeHead(code.id, code.title);

      if ("bytes" in content.body) {
        response.end(content.body.bytes);
      }
    } else if ("noContent" in rpcResponse) {
      var noContent = rpcResponse.noContent;
      var noContentCode = noContentSuccessCodes[noContent.shouldResetForm * 1];
      response.writeHead(noContentCode.id, noContentCode.title);
      response.end();
    } else if ("redirect" in rpcResponse) {
      var redirect = rpcResponse.redirect;
      var redirectCode = redirectCodes[redirect.switchToGet * 2 + redirect.isPermanent];
      response.writeHead(redirectCode.id, redirectCode.title, {
        "Location": redirect.location
      });
      response.end();
    } else if ("clientError" in rpcResponse) {
      var clientError = rpcResponse.clientError;
      var errorCode = errorCodes[clientError.statusCode];
      if (!errorCode) {
        throw new Error("Unknown status code: ", clientError.statusCode);
      }
      response.writeHead(errorCode.id, errorCode.title, {
        "Content-Type": "text/html"
      });
      if (clientError.descriptionHtml) {
        response.end(clientError.descriptionHtml);
      } else {
        // TODO(someday):  Better default error page.
        response.end("<html><body><h1>" + errorCode.id + ": " + errorCode.title +
                     "</h1></body></html>");
      }
    } else if ("serverError" in rpcResponse) {
      response.writeHead(500, "Internal Server Error", {
        "Content-Type": "text/html"
      });
      if (rpcResponse.serverError.descriptionHtml) {
        response.end(rpcResponse.serverError.descriptionHtml);
      } else {
        // TODO(someday):  Better default error page.
        response.end("<html><body><h1>500: Internal Server Error</h1></body></html>");
      }
    } else {
      throw new Error("Unknown HTTP response type:\n" + JSON.stringify(rpcResponse));
    }

  }).catch(function (error) {
    return self.maybeRetryAfterError(error, retryCount).then(function () {
      return self.handleRequest(request, data, response, retryCount + 1);
    });
  });
}

// -----------------------------------------------------------------------------
// WebSocket handling

function WebSocketReceiver(socket) {
  var queue = [];
  this.go = function () {
    for (var i in queue) {
      socket.write(queue[i]);
    }
    queue = null;
  };
  this.sendBytes = function (message) {
    // TODO(someday):  Flow control of some sort?
    if (queue === null) {
      socket.write(message);
    } else {
      queue.push(message);
    }
  };
  // TODO(soon):  Shutdown write when dropped.  Requires support for "reactToLostClient()".
}

function pumpWebSocket(socket, rpcStream) {
  socket.on("data", function (chunk) {
    rpcStream.sendBytes(chunk).catch(function (err) {
      console.error("WebSocket sendBytes failed: " + err.stack);
      socket.destroy();
    });
  });
  socket.on("end", function (chunk) {
    rpcStream.close();
  });
}

Proxy.prototype.handleWebSocket = function (request, socket, head, retryCount) {
  var self = this;

  return Promise.resolve(undefined).then(function () {
    return self.makeContext(request);
  }).then(function (context) {
    var path = request.url.slice(1);  // remove leading '/'
    var session = self.getSession(request);

    if (!("sec-websocket-key" in request.headers)) {
      throw new Error("Missing Sec-WebSocket-Accept header.");
    }

    var magic = request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    var acceptKey = Crypto.createHash("sha1").update(magic).digest("base64");

    var protocols = [];
    if ("sec-websocket-protocol" in request.headers) {
      protocols = request.headers["sec-websocket-protocol"]
          .split(",").map(function (s) { return s.trim(); });
    }

    var receiver = new WebSocketReceiver(socket);

    var promise = session.openWebSocket(path, context, protocols, receiver);

    if (head.length > 0) {
      promise.serverStream.sendBytes(head);
    }
    pumpWebSocket(socket, promise.serverStream);

    return promise.then(function (response) {
      var headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Accept: " + acceptKey];
      if (response.protocol && response.protocol.length > 0) {
        headers.push("Sec-WebSocket-Protocol: " + response.protocol.join(", "));
      }
      headers.push("");
      headers.push("");

      socket.write(headers.join("\r\n"));
      receiver.go();

      // Note:  At this point errors are out of our hands.
    });
  }).catch(function (error) {
    return self.maybeRetryAfterError(error, retryCount).then(function () {
      return self.handleWebSocket(request, socket, head, retryCount + 1);
    });
  });
}

// =======================================================================================
// Debug log access

Meteor.publish("grainLog", function (grainId) {
  check(grainId, String);
  var grain = Grains.findOne(grainId);
  if (!grain || !this.userId || grain.userId !== this.userId) {
    this.added("grainLog", 0, {text: "Only the grain owner can view the debug log."});
    this.ready();
    return;
  }

  var logfile = SANDSTORM_GRAINDIR + "/" + grainId + "/log";

  var fd = Fs.openSync(logfile, "r");
  var startSize = Fs.fstatSync(fd).size;

  // Start tailing at EOF - 8k.
  var offset = Math.max(0, startSize - 8192);

  var self = this;
  function doTail() {
    for (;;) {
      var buf = new Buffer(Math.max(1024, startSize - offset));
      var n = Fs.readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      self.added("grainLog", offset, {text: buf.toString("utf8", 0, n)});
      offset += n;
    }
  }

  // Watch the file for changes.
  var watcher = Fs.watch(logfile, {persistent: false}, Meteor.bindEnvironment(doTail));

  // When the subscription stops, stop watching the file.
  this.onStop(function() {
    watcher.close();
    Fs.closeSync(fd);
  });

  // Read initial 8k tail data immediately.
  doTail();

  // Notify ready.
  this.ready();
});
