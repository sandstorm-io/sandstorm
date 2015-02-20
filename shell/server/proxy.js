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
var Url = Npm.require("url");
var Promise = Npm.require("es6-promise").Promise;
var Capnp = Npm.require("capnp");

var ByteStream = Capnp.importSystem("sandstorm/util.capnp").ByteStream;
var ApiSession = Capnp.importSystem("sandstorm/api-session.capnp").ApiSession;
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

    var proxy = new Proxy(grainId, sessionId, null, isOwner, user, null, false);
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

  return error.type === "disconnected" && retryCount < 1;
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
    Sessions.remove({grainId: grainId});
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

Meteor.startup(function () {
  // Every time the set of dev apps changes, clear all sessions.
  DevApps.find().observeChanges({
    removed : function (app) {
      Sessions.remove({});
    },
    added : function (app) {
      Sessions.remove({});
    }
  });

  Sessions.find().observeChanges({
    removed : function(session) {
      delete proxies[session._id];
      delete proxiesByHostId[session.hostId];
    }
  });
});

// Kill off proxies idle for >~5 minutes.
var TIMEOUT_MS = 300000;
function gcSessions() {
  var now = new Date().getTime();
  Sessions.remove({timestamp: {$lt: (now - TIMEOUT_MS)}});
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
    var proxy = new Proxy(session.grainId, session._id, session.hostId, isOwner, user, null, false);
    proxies[session._id] = proxy;
    proxiesByHostId[session.hostId] = proxy;
  });
});

// =======================================================================================
// API tokens

var proxiesByApiToken = {};

function getProxyForApiToken(token) {
  check(token, String);
  var hashedToken = Crypto.createHash("sha256").update(token).digest("base64");
  return Promise.resolve(undefined).then(function () {
    if (hashedToken in proxiesByApiToken) {
      var proxy = proxiesByApiToken[hashedToken];
      if (proxy.expires && proxy.expires.getTime() <= Date.now()) {
        throw new Meteor.Error(403, "Authorization token expired");
      }
      return proxy;
    } else {
      return inMeteor(function () {
        var tokenInfo = ApiTokens.findOne(hashedToken);
        if (!tokenInfo) {
          throw new Meteor.Error(403, "Invalid authorization token");
        }

        if (tokenInfo.expires && tokenInfo.expires.getTime() <= Date.now()) {
          throw new Meteor.Error(403, "Authorization token expired");
        }

        var grain = Grains.findOne(tokenInfo.grainId);
        if (!grain) {
          // Grain was deleted, I guess.
          throw new Meteor.Error(410, "Resource has been deleted");
        }

        var proxy;
        if (tokenInfo.userInfo) {
          // Hack: When Mongo stores a Buffer, it comes back as some other type.
          if ("userId" in tokenInfo.userInfo) {
            tokenInfo.userInfo.userId = new Buffer(tokenInfo.userInfo.userId);
          }
          proxy = new Proxy(tokenInfo.grainId, null, null, false, null, tokenInfo.userInfo, true);
        } else if (tokenInfo.userId) {
          var user = Meteor.users.findOne({_id: tokenInfo.userId});
          if (!user) {
            throw new Meteor.Error(403, "User has been deleted");
          }

          var isOwner = grain.userId === tokenInfo.userId;
          proxy = new Proxy(tokenInfo.grainId, null, null, isOwner, user, null, true);
        } else {
          proxy = new Proxy(tokenInfo.grainId, null, null, false, null, null, true);
        }

        if (tokenInfo.expires) {
          proxy.expires = tokenInfo.expires;
        }

        proxiesByApiToken[hashedToken] = proxy;

        return proxy;
      });
    }
  });
}

function apiUseBasicAuth(req) {
  // For clients with no convenient way to add an "Authorization: Bearer" header, we allow the token
  // to be transmitted as a basic auth password.
  var agent = req.headers["user-agent"];
  if (agent && agent.slice(0, 4) === "git/") {
    return true;
  } else {
    return false;
  }
}

function apiTokenForRequest(req) {
  var auth = req.headers.authorization;
  if (auth && auth.slice(0, 7).toLowerCase() === "bearer ") {
    return auth.slice(7).trim();
  } else if (auth && auth.slice(0, 6).toLowerCase() === "basic " && apiUseBasicAuth(req)) {
    return (new Buffer(auth.slice(6).trim(), "base64")).toString().split(":")[1];
  } else {
    return undefined;
  }
}

// =======================================================================================
// Routing to proxies.
//

tryProxyUpgrade = function (hostId, req, socket, head) {
  if (hostId === "api") {
    var token = apiTokenForRequest(req);
    if (token) {
      getProxyForApiToken(token).then(function (proxy) {
        // Meteor sets the timeout to five seconds. Change that back to two
        // minutes, which is the default value.
        socket.setTimeout(120000);

        proxy.upgradeHandler(req, socket, head);
      }, function (err) {
        socket.destroy();
      });
    } else {
      socket.destroy();
    }
    return true;
  } else {
    var origin = req.headers.origin;
    if (origin !== (PROTOCOL + "//" + req.headers.host)) {
      console.error("Detected illegal cross-origin WebSocket from:", origin);
      socket.destroy();
      return true;
    }

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
}

tryProxyRequest = function (hostId, req, res) {
  if (hostId === "api") {
    // This is a request for the API host.

    if (req.method === "OPTIONS") {
      // Reply to CORS preflight request.

      // All we want to do is permit APIs to be accessed from arbitrary origins. Since clients must
      // send a valid Authorization header, and since cookies are not used for authorization, this
      // is perfectly safe. In a sane world, we would only need to send back
      // "Access-Control-Allow-Origin: *" and be done with it.
      //
      // However, CORS demands that we explicitly whitelist individual methods and headers for use
      // cross-origin, as if this is somehow useful for implementing any practical security policy
      // (it isn't). To make matters worse, we are REQUIRED to enumerate each one individually.
      // We cannot just write "*" for these lists. WTF, CORS?
      //
      // Luckily, the request tells us exactly what method and headers are being requested, so we
      // only need to copy those over, rather than create an exhaustive list. But this is still
      // overly complicated.

      var accessControlHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE",
        "Access-Control-Max-Age": "3600"
      };

      // Copy all requested headers to the allowed headers list.
      var requestedHeaders = req.headers["access-control-request-headers"];
      if (requestedHeaders) {
        accessControlHeaders["Access-Control-Allow-Headers"] = requestedHeaders;
      }

      // Add the requested method to the allowed methods list, if it's not there already.
      var requestedMethod = req.headers["access-control-request-method"];
      if (requestedMethod &&
          !(_.contains(["GET", "HEAD", "POST", "PUT", "DELETE"], requestedMethod))) {
        accessControlHeaders["Access-Control-Allow-Methods"] += ", " + requestedMethod;
      }

      res.writeHead(204, accessControlHeaders);
      res.end();
      return true;
    }

    var token = apiTokenForRequest(req);
    if (token) {
      getProxyForApiToken(token).then(function (proxy) {
        proxy.requestHandler(req, res);
      }, function (err) {
        if (err instanceof Meteor.Error) {
          res.writeHead(err.error, err.reason, { "Content-Type": "text/plain" });
        } else {
          res.writeHead(500, "Internal Server Error", { "Content-Type": "text/plain" });
        }
        res.end(err.stack);
      });
    } else {
      if (apiUseBasicAuth(req)) {
        res.writeHead(401, {"Content-Type": "text/plain",
                            "WWW-Authenticate": "Basic realm=\"Sandstorm API\""});
      } else {
        // TODO(someday): Display some sort of nifty API browser.
        res.writeHead(403, {"Content-Type": "text/plain"});
      }
      res.end("Missing or invalid authorization header.\n\n" +
          "This address serves APIs, which allow external apps (such as a phone app) to\n" +
          "access data on your Sandstorm server. This address is not meant to be opened\n" +
          "in a regular browser.");
    }
    return true;
  } else if (hostId in proxiesByHostId) {
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

function Proxy(grainId, sessionId, preferredHostId, isOwner, user, userInfo, isApi) {
  this.grainId = grainId;
  this.sessionId = sessionId;
  this.isOwner = isOwner;
  this.isApi = isApi;
  if (sessionId) {
    if (!preferredHostId) {
      this.hostId = generateRandomHostname(20);
    } else {
      this.hostId = preferredHostId;
    }
  }

  if (userInfo) {
    this.userInfo = userInfo;
  } else if (user) {
    var serviceId;
    if (user.expires) {
      serviceId = "demo:" + user._id;
    } else if (user.devName) {
      serviceId = "dev:" + user.devName;
    } else if (user.services && user.services.google) {
      serviceId = "google:" + user.services.google.id;
    } else if (user.services && user.services.github) {
      serviceId = "github:" + user.services.github.id;
    } else {
      // Make sure that if we add a new user type we don't forget to update this.
      throw new Meteor.Error(500, "Unknown user type.");
    }
    this.userInfo = {
      // Fallback to service specific names if profile.name is missing
      displayName: {defaultText: user.profile.name ||
        (user.services && user.services.github && user.services.github.username) ||
        (user.services && user.services.google && user.services.google.email &&
          user.services.google.email.slice(0, user.services.google.email.indexOf('@'))) ||
        'Unknown Name'},
      userId: Crypto.createHash("sha256").update(serviceId).digest()
    }
  } else {
    this.userInfo = {
      displayName: {defaultText: "Anonymous User"}
    }
  }

  var self = this;

  this.requestHandler = function (request, response) {
    if (this.sessionId) {
      // Implement /_sandstorm-init for setting the session cookie.
      var url = Url.parse(request.url, true);
      if (url.pathname === "/_sandstorm-init" && url.query.sessionid === self.sessionId) {
        self.doSessionInit(request, response, url.query.path);
        return;
      }
    }

    Promise.resolve(undefined).then(function () {
      var contentLength = request.headers["content-length"];
      if ((request.method === "POST" || request.method === "PUT") &&
          (contentLength === undefined || contentLength > 1024 * 1024)) {
        // The input is either very long, or we don't know how long it is, so use streaming mode.
        return self.handleRequestStreaming(request, response, contentLength, 0);
      } else {
        return readAll(request).then(function (data) {
          return self.handleRequest(request, data, response, 0);
        });
      }
    }).catch(function (err) {
      var body = err.stack;
      if (err.cppFile) {
        body += "\nC++ location:" + err.cppFile + ":" + (err.line || "??");
      }
      if (err.type) {
        body += "\ntype: " + err.type;
      }

      if (response.headersSent) {
        // Unfortunately, it's too late to tell the client what happened.
        console.error("HTTP request failed after response already sent:", body);
        response.end();
      } else {
        if (err instanceof Meteor.Error) {
          response.writeHead(err.error, err.reason, { "Content-Type": "text/plain" });
        } else {
          response.writeHead(500, "Internal Server Error", { "Content-Type": "text/plain" });
        }
        response.end(body);
      }
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

Proxy.prototype._callNewWebSession = function (request, userInfo) {
  var params = Capnp.serialize(WebSession.Params, {
    basePath: PROTOCOL + "//" + request.headers.host,
    userAgent: "user-agent" in request.headers
        ? request.headers["user-agent"]
        : "UnknownAgent/0.0",
    acceptableLanguages: "accept-language" in request.headers
        ? request.headers["accept-language"].split(",").map(function (s) { return s.trim(); })
        : [ "en-US", "en" ]
  });

  return this.uiView.newSession(userInfo, makeHackSessionContext(this.grainId),
                                WebSession.typeId, params).session;
};

Proxy.prototype._callNewApiSession = function (request, userInfo) {
  var self = this;

  // TODO(someday): We are currently falling back to WebSession if we get any kind of error upon
  // calling newSession with an ApiSession._id.
  // Eventually we'll remove this logic once we're sure apps have updated.
  return this.uiView.newSession(
    userInfo, makeHackSessionContext(this.grainId), ApiSession.typeId
  ).then(function (session) {
    return session.session;
  }, function (err) {
    return self._callNewWebSession(request, userInfo);
  });
};

Proxy.prototype._callNewSession = function (request, viewInfo) {
  var userInfo = _.clone(this.userInfo);
  if (viewInfo.permissions) {
    var numBytes = Math.ceil(viewInfo.permissions.length / 8);

    var buf = new Buffer(numBytes);
    for(var i = 0; i < numBytes; i++) {
      buf.writeUInt8(this.isOwner * 255, i);
    }

    userInfo.permissions = buf;
  }

  if (this.isApi) {
    return this._callNewApiSession(request, userInfo);
  } else {
    return this._callNewWebSession(request, userInfo);
  }
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

function parseAcceptHeader(request) {
  var header = request.headers["accept"];

  var result = [];
  if (header) {
    var acceptList = header.split(",");
    for (var i in acceptList) {
      var acceptStr = acceptList[i];
      var tokensList = acceptStr.split(";");

      var temp = {mimeType: tokensList[0].trim()};

      var tokensListRest = tokensList.slice(1);
      for (var j in tokensListRest) {
        var token = tokensListRest[j];
        var equalsPos = token.indexOf('=');
        if (equalsPos) {
          var key = token.slice(0, equalsPos).trim();
          var value = token.slice(equalsPos + 1).trim();

          if (key === 'q') {
            temp.qValue = +value;
          }
        }
      }
      result.push(temp);
    }
  }

  return result;
}

Proxy.prototype.doSessionInit = function (request, response, path) {
  path = path || "/";

  // Check that the path is relative (ie. starts with a /).
  // Also ensure that it doesn't start with 2 /, because that is interpreted as non-relative
  if (path.lastIndexOf("/", 0) !== 0 || path.lastIndexOf("//", 0) === 0) {
    response.writeHead(400, "Invalid path supplied", { "Content-Type": "text/plain" });
    response.end("Invalid path supplied.");
    return;
  }

  // Set the session ID.
  response.setHeader("Set-Cookie", ["sandstorm-sid=", this.sessionId, "; Max-Age=31536000; HttpOnly"].join(""));

  response.setHeader("Cache-Control", "no-cache, private");

  // Redirect to the app's root URL.
  // Note:  All browsers support relative locations and the next update to HTTP/1.1 will officially
  //   make them valid.  http://tools.ietf.org/html/draft-ietf-httpbis-p2-semantics-26#page-67
  response.writeHead(303, "See Other", { "Location": path });
  response.end();
}

Proxy.prototype.makeContext = function (request, response) {
  // Parses the cookies from the request, checks that the session ID is present and valid, then
  // returns the request context which contains the other cookies.  Throws an exception if the
  // session ID is missing or invalid.

  var context = {};

  if (this.hostId) {
    var parseResult = parseCookies(request);
    if (!parseResult.sessionId || parseResult.sessionId !== this.sessionId) {
      throw new Meteor.Error(403, "Unauthorized");
    }

    if (parseResult.cookies.length > 0) {
      context.cookies = parseResult.cookies;
    }
  } else {
    // This is an API request. Cookies are not supported.
  }

  context.accept = parseAcceptHeader(request);

  var promise = new Promise(function (resolve, reject) {
    response.resolveResponseStream = resolve;
    response.rejectResponseStream = reject;
  });

  context.responseStream = new Capnp.Capability(promise, ByteStream);

  return context;
}

// -----------------------------------------------------------------------------
// Regular HTTP request handling

function readAll(stream) {
  return new Promise(function (resolve, reject) {
    var buffers = [];
    stream.on("data", function (buf) {
      buffers.push(buf);
    });
    stream.on("end", function () {
      resolve(Buffer.concat(buffers));
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

function ResponseStream(response, streamHandle, resolve, reject) {
  this.response = response;
  this.streamHandle = streamHandle;
  this.resolve = resolve;
  this.reject = reject;
  this.ended = false;
}

ResponseStream.prototype.write = function (data) {
  this.response.write(data);
}

ResponseStream.prototype.done = function () {
  this.response.end();
  this.streamHandle.close();
  this.ended = true;
}

ResponseStream.prototype.close = function () {
  if (this.ended) {
    this.resolve();
  } else {
    this.streamHandle.close();
    this.reject(new Error("done() was never called on outbound stream."));
  }
}

Proxy.prototype.translateResponse = function (rpcResponse, response) {
  if (this.hostId) {
    if (rpcResponse.setCookies && rpcResponse.setCookies.length > 0) {
      response.setHeader("Set-Cookie", rpcResponse.setCookies.map(makeSetCookieHeader));
    }

    // TODO(security): Add a Content-Security-Policy header which:
    // (1) Prevents the app from initiating HTTP requests to third parties.
    // (2) Prevents the app from navigating the parent frame.
    // (3) Prevents the app from opening popups.
    // (4) Prohibits anyone other than the Sandstorm shell from framing the app (as a backup
    //   defense vs. clickjacking, though unguessable hostnames already mostly prevent this).
  } else {
    // This is an API request. Cookies are not supported.

    // We need to make sure caches know that different bearer tokens get totally different results.
    response.setHeader("Vary", "Authorization");

    // APIs can be called from any origin. Because we ignore cookies, there is no security problem.
    response.setHeader("Access-Control-Allow-Origin", "*");

    // Add a Content-Security-Policy as a backup in case someone finds a way to load this resource
    // in a browser context. This policy should thoroughly neuter it.
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  }

  // TODO(security): Set X-Content-Type-Options: nosniff?

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
    if (("disposition" in content) && ("download" in content.disposition)) {
      response.setHeader("Content-Disposition", "attachment; filename=\"" +
          content.disposition.download.replace(/([\\"\n])/g, "\\$1") + "\"");
    }
    if ("stream" in content.body) {
      var streamHandle = content.body.stream;
      response.writeHead(code.id, code.title);
      var promise = new Promise(function (resolve, reject) {
        response.resolveResponseStream(new Capnp.Capability(
            new ResponseStream(response, streamHandle, resolve, reject), ByteStream));
      });
      promise.streamHandle = streamHandle;
      return promise;
    } else {
      response.rejectResponseStream(
        new Error("Response content body was not a stream."));

      if ("bytes" in content.body) {
        response.setHeader("Content-Length", content.body.bytes.length);
      } else {
        throw new Error("Unknown content body type.");
      }
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

  return Promise.resolve(undefined);
}

Proxy.prototype.handleRequest = function (request, data, response, retryCount) {
  var self = this;

  return Promise.resolve(undefined).then(function () {
    return self.makeContext(request, response);
  }).then(function (context) {
    // Send the RPC.
    var path = request.url.slice(1);  // remove leading '/'
    var session = self.getSession(request);

    if (request.method === "GET") {
      return session.get(path, context);
    } else if (request.method === "POST") {
      return session.post(path, {
        mimeType: request.headers["content-type"] || "application/octet-stream",
        content: data,
        encoding: request.headers["content-encoding"]
      }, context);
    } else if (request.method === "PUT") {
      return session.put(path, {
        mimeType: request.headers["content-type"] || "application/octet-stream",
        content: data,
        encoding: request.headers["content-encoding"]
      }, context);
    } else if (request.method === "DELETE") {
      return session.delete(path, context);
    } else {
      throw new Error("Sandstorm only supports GET, POST, PUT, and DELETE requests.");
    }

  }).then(function (rpcResponse) {
    return self.translateResponse(rpcResponse, response);
  }).catch(function (error) {
    return self.maybeRetryAfterError(error, retryCount).then(function () {
      return self.handleRequest(request, data, response, retryCount + 1);
    });
  });
}

Proxy.prototype.handleRequestStreaming = function (request, response, contentLength, retryCount) {
  var self = this;
  var context = this.makeContext(request, response);
  var path = request.url.slice(1);  // remove leading '/'
  var session = this.getSession(request);

  var mimeType = request.headers["content-type"] || "application/octet-stream";
  var encoding = request.headers["content-encoding"]

  var requestStreamPromise;
  if (request.method === "POST") {
    requestStreamPromise = session.postStreaming(path, mimeType, context, encoding);
  } else if (request.method === "PUT") {
    requestStreamPromise = session.putStreaming(path, mimeType, context, encoding);
  } else {
    throw new Error("Sandstorm only supports streaming POST and PUT requests.");
  }

  // TODO(perf): We ought to be pipelining the body, but we can't currently, because we have to
  //   handle the case where the app doesn't actually support streaming. We could pipeline while
  //   also buffering the data on the side in case we need it again later, but that's kind of
  //   complicated. We should fix the whole protocol to make streaming the standard.
  return requestStreamPromise.then(function(requestStreamResult) {
    var requestStream = requestStreamResult.stream;

    // Initialized when getResponse() returns, if the response is streaming.
    var downloadStreamHandle;

    // Initialized if an upload-stream method throws.
    var uploadStreamError;

    // We call `getResponse()` immediately so that the app can start streaming data down even while
    // data is still being streamed up. This theoretically allows apps to perform bidirectional
    // streaming, though probably very few actually do that.
    //
    // Note that we need to be able to cancel `responsePromise` below, so it's important that it is
    // the raw Cap'n Proto promise. Hence `translateResponsePromise` is a separate variable.
    var responsePromise = requestStream.getResponse();

    function reportUploadStreamError(err) {
      // Called when an upload-stream method throws.

      if (!uploadStreamError) {
        uploadStreamError = err;

        // If we're still waiting on any response stuff, cancel it.
        responsePromise.cancel();
        requestStream.close();
        if (downloadStreamHandle) {
          downloadStreamHandle.close();
        }
      }
    }

    // If we have a Content-Length, pass it along to the app by calling `expectSize()`.
    if (contentLength !== undefined) {
      requestStream.expectSize(contentLength).catch(function (err) {
        // expectSize() is allowed to be unimplemented.
        if (err.type !== "unimplemented") {
          reportUploadStreamError(err);
        }
      });
    }

    // Pipe the input stream to the app.
    request.on("data", function (buf) {
      // TODO(soon): Only allow a small number of write()s to be in-flight at once,
      //   pausing the input stream if we hit that limit, so that we block the TCP socket all the
      //   way back to the source. May want to also coalesce small writes for this purpose.
      // TODO(security): The above problem may allow a DoS attack on the frost-end.
      if (!uploadStreamError) requestStream.write(buf).catch(reportUploadStreamError);
    });
    request.on("end", function () {
      if (!uploadStreamError) requestStream.done().catch(reportUploadStreamError);

      // We're all done making calls to requestStream.
      requestStream.close();
    });
    request.on("close", function () {
      reportUploadStreamError(new Error("HTTP connection unexpectedly closed during request."));
    });
    request.on("error", function (err) {
      reportUploadStreamError(err);
    });

    return responsePromise.then(function (rpcResponse) {
      // Stop here if the upload stream has already failed.
      if (uploadStreamError) throw uploadStreamError;

      var promise = self.translateResponse(rpcResponse, response);
      downloadStreamHandle = promise.streamHandle;
      return promise;
    });
  }, function (err) {
    if (err.type === "failed" && err.message.indexOf("not implemented") !== -1) {
      // Hack to work around old apps using an old version of Cap'n Proto, before the
      // "unimplemented" exception type was introduced. :(
      // TODO(cleanup): When we transition to API version 2, we can move this into the
      //   compatibility layer.
      err.type = "unimplemented";
    }

    if (shouldRestartGrain(err, 0)) {
      // This is the kind of error that indicates we should retry. Note that we passed 0 for the
      // retry count above because we were just checking if this is a retriable error (vs. possibly
      // a method-not-implemented error); maybeRetryAfterError() will check again with the proper
      // retry count.
      return self.maybeRetryAfterError(err, retryCount).then(function () {
        return self.handleRequestStreaming(request, response, contentLength, retryCount + 1);
      });
    } else if (err.type === "unimplemented") {
      // Streaming is not implemented. Fall back to non-streaming version.
      return readAll(request).then(function (data) {
        return self.handleRequest(request, data, response, 0);
      });
    } else {
      throw err;
    }
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
  this.close = function () {
    socket.end();
  };
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
