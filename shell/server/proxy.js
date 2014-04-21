// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// This file is part of the Sandstorm platform implementation.
//
// Sandstorm is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Sandstorm is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public
// License along with Sandstorm.  If not, see
// <http://www.gnu.org/licenses/>.

var Crypto = Npm.require("crypto");
var ChildProcess = Npm.require("child_process");
var Fs = Npm.require("fs");
var Path = Npm.require("path");
var Future = Npm.require("fibers/future");
var Http = Npm.require("http");

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

function inMeteor(callback) {
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
  // TODO(cleanup):  Figure out if Meteor.bindEnvironment() is necessary here...
//  promise.then(Meteor.bindEnvironment(result.return.bind(result)),
//               Meteor.bindEnvironment(result.throw.bind(result)));
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

Meteor.methods({
  newGrain: function (packageId, command, title) {
    // Create and start a new grain.

    if (!this.userId) {
      throw new Meteor.Error(403, "Unauthorized", "Must be logged in to create grains.");
    }

    var package = Packages.findOne(packageId);
    var appId;
    var manifest;
    if (package) {
      appId = package.appId;
      manifest = package.manifest;
    } else {
      var devApp = DevApps.findOne({packageId: packageId});
      if (devApp) {
        appId = devApp._id;
        manifest = devApp.manifest;
      } else {
        throw new Meteor.Error(404, "Not Found", "No such package is installed.");
      }
    }

    var grainId = Random.id(22);
    var publicId = Random.id(22);
    Grains.insert({
      _id: grainId,
      packageId: packageId,
      appId: appId,
      appVersion: manifest.appVersion,
      userId: this.userId,
      title: title,
      publicId: publicId
    });
    startGrainInternal(packageId, grainId, command, true);
    return grainId;
  },

  openSession: function (grainId) {
    // Open a new UI session on an existing grain.  Starts the grain if it is not already
    // running.

    check(grainId, String);

    var sessionId = Random.id();

    // Start the grain if it is not running.
    var runningGrain = runningGrains[grainId];
    if (runningGrain) {
      waitPromise(runningGrain);
    } else {
      continueGrain(grainId);
    }

    var proxy = new Proxy(grainId, sessionId);
    proxies[sessionId] = proxy;
    var port = waitPromise(proxy.getPort());

    Sessions.insert({
      _id: sessionId,
      grainId: grainId,
      port: port,
      timestamp: new Date().getTime()
    });

    return {sessionId: sessionId, port: port};
  },

  sendEmailToGrain: function (grainId, emailMessage) {
    // Send an email message to a grain

    check(grainId, String);
    check(grainId, String);

    var session = Meteor.call("openSession", grainId);

    var proxy = proxies[session.sessionId];

    try {
      waitPromise(proxy.getSession({headers: {}}).send(emailMessage));
    }
    catch (e) {
      console.error(e.message);
    }
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
  }
});

function updateLastActive(grainId, userId) {
  var now = new Date();
  Grains.update(grainId, {$set: {lastUsed: now}});
  if (userId) {
    Meteor.users.update(userId, {$set: {lastActive: now}});
  }
}

function continueGrain(grainId) {
  var grain = Grains.findOne(grainId);
  if (!grain) {
    throw new Meteor.Error(404, "Grain Not Found", "Grain ID: " + grainId);
  }

  var manifest;
  var packageId;
  var devApp = DevApps.findOne({_id: grain.appId});
  if (devApp) {
    // If a DevApp with the same app ID is currently active, we let it override the installed
    // package, so that the grain runs using the dev app.
    manifest = devApp.manifest;
    packageId = devApp.packageId;
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

  startGrainInternal(packageId, grainId, manifest.continueCommand, false);
}

function startGrainInternal(packageId, grainId, command, isNew) {
  // Starts the grain supervisor.  Must be executed in a Meteor context.  Blocks until grain is
  // started.

  var args = [packageId, grainId];
  if (isNew) args.push("-n");
  if (command.environ) {
    for (var i in command.environ) {
      args.push(["-e", command.environ[i].key, "=", command.environ[i].value].join(""));
    }
  }

  if (SANDSTORM_ALTHOME) {
    args.push("--home=" + SANDSTORM_ALTHOME);
  }

  args.push("--");

  // Ugly: Stay backwards-compatible with old manifests that had "executablePath" and "args" rather
  //   than just "argv".
  var exePath = command.deprecatedExecutablePath || command.executablePath;
  if (exePath) {
    args.push(exePath);
  }
  args = args.concat(command.argv || command.args);

  var proc = ChildProcess.spawn(sandstormExe("sandstorm-supervisor"), args, {
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
      resolve();
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

  // While we're waiting...
  updateLastActive(grainId, Meteor.userId());

  runningGrains[grainId] = whenReady;
  waitPromise(whenReady);
}

shutdownGrain = function (grainId) {
  Sessions.find({grainId: grainId}).forEach(function (session) {
    var proxy = proxies[session._id];
    if (proxy) {
      proxy.close();
      delete proxies[session._id];
    }
    Sessions.remove(session._id);
  });

  // Try to send a shutdown.  The grain may not be running, in which case this will fail, which
  // is fine.  In fact even if the grain is running, we expect the call to fail because the grain
  // kills itself before returning.
  var connection = Capnp.connect("unix:" + Path.join(SANDSTORM_GRAINDIR, grainId, "socket"));
  var supervisor = connection.restore(null, Supervisor);

  supervisor.shutdown().then(function (result) {
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

// Kill off proxies idle for >~5 minutes.
var TIMEOUT_MS = 300000;
function gcSessions() {
  var now = new Date().getTime();
  Sessions.find({timestamp: {$lt: (now - TIMEOUT_MS)}}).forEach(function (session) {
    var proxy = proxies[session._id];
    if (proxy) {
      proxy.close();
      delete proxies[session._id];
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
  var firstPort = nextPort;
  var usedPorts = {};
  Sessions.find({}).forEach(function (session) {
    // Try to recreate the proxy on the same port as before.
    var proxy = new Proxy(session.grainId, session._id, session.port);

    try {
      waitPromise(proxy.getPort());
    } catch (err) {
      // Dang, can't restore this session.
      Sessions.remove(session._id);
      return;
    }

    proxies[session._id] = proxy;

    // If the port looks like one we might accidentally reassign, move nextPort past it and arrange
    // to omit it from availablePorts.
    if (session.port >= firstPort && session.port < firstPort + 256) {
      nextPort = Math.max(session.port + 1, nextPort);
      usedPorts[session.port] = true;
    }
  });

  // Any ports in the range [firstPort, nextPort) that were not re-opened should be considered
  // available.
  for (var i = nextPort - 1; i >= firstPort; i--) {
    if (!(i in usedPorts)) {
      availablePorts.push(i);
    }
  }
});

// =======================================================================================
// Proxy class
//
// Connects to a grain and exports it on an HTTP port.
//
// The method getPort() returns a promise for a port number which resolves as soon as it's ready
// to receive connections.

var availablePorts = [];
var nextPort = 7000;  // If we run out of ports, open this one and increment counter.

function choosePort() {
  if (availablePorts.length == 0) {
    return nextPort++;
  } else {
    return availablePorts.pop();
  }
}

function Proxy(grainId, sessionId, preferredPort) {
  this.grainId = grainId;
  this.sessionId = sessionId;

  var self = this;

  var grain = Grains.findOne(this.grainId);
  this.publicId = grain.publicId;

  this.server = Http.createServer(function (request, response) {
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
  });

  this.server.on("upgrade", function (request, socket, head) {
    self.handleWebSocket(request, socket, head, 0).catch(function (err) {
      console.error("WebSocket setup failed:", err.stack);
      // TODO(cleanup):  Manually send back a 500 response?
      socket.destroy();
    });
  });

  // Choose a port and make sure we actually manage to open it.
  var portPromise = new Promise(function (resolve, reject) {
    var port = preferredPort || choosePort();
    var errorCount = 0;
    self.server.listen(port);
    self.server.on("listening", function () {
      resolve(port);
    });
    self.server.on("error", function (err) {
      if (preferredPort || err.code !== "EADDRINUSE") {
        self.server.close();
        delete self.server;
        reject(err);
      } else if (errorCount++ < 16) {
        // Try the next port.
        port = choosePort();
        self.server.listen(port);
      } else {
        self.server.close();
        delete self.server;
        reject(new Error(
            "Couldn't find a port to use.  Is something else using the same port " +
            "range as Sandstorm?"));
      }
    });
  });

  this.getPort = function () { return portPromise; }
}

Proxy.prototype.getConnection = function () {
  // TODO(perf):  Several proxies could share a connection if opening the same grain in multiple
  //   tabs.  Each should be a separate session.
  if (!this.connection) {
    this.connection = Capnp.connect("unix:" +
        Path.join(SANDSTORM_GRAINDIR, this.grainId, "socket"));
    this.supervisor = this.connection.restore(null, Supervisor);
    this.uiView = this.supervisor.getMainView().view;
  }
  return this.connection;
}

var formatAddress = function(field) {
  if(!field)
    return null;

  if (Array.isArray(field))
    return field.forEach(formatAddress);

  if(field.name)
    return field.name + ' <' + field.address + '>';

  return field.address;
};

var rethrowException = function(error) {
  throw error;
};

function HackSessionImpl(grainId, publicId) {
  this.grainId = grainId;
  this.publicId = publicId;
}

HackSessionImpl.prototype.send = Meteor.bindEnvironment(function(email) {
  expectedFrom = this.publicId + '@' + HOSTNAME; // HOSTNAME is defined in mail.js startup
  if(email.from.address.toUpperCase() !== expectedFrom.toUpperCase()) {
    console.warn("From field's address was not the expected address for this grain: " +
      email.from.address + " instead of " + expectedFrom);
    email.from.address = expectedFrom;
  }

  var newEmail = {
    from:     formatAddress(email.from),
    to:       formatAddress(email.to),
    cc:       formatAddress(email.cc),
    bcc:      formatAddress(email.bcc),
    replyTo:  formatAddress(email.replyTo),
    subject:  email.subject,
    text:     email.text,
    html:     email.html
  };

  var headers = {};
  if(email.messageId)
    headers['message-id'] = email.messageId;
  if(email.references)
    headers['references'] = email.references;
  if(email.messageId)
    headers['in-reply-to'] = email.inReplyTo;
  // if(email.date)
  //   headers['date'] = email.date;
  // TODO: parse and set date

  newEmail['headers'] = headers;

  Email.send(newEmail);
}, rethrowException);

Proxy.prototype.getSession = function (request) {
  if (!this.session) {
    this.getConnection();  // make sure we're connected
    var params = Capnp.serialize(WebSession.Params, {
      basePath: "http://127.0.0.1:3004",
      userAgent: "user-agent" in request.headers
          ? request.headers["user-agent"]
          : "UnknownAgent/0.0",
      acceptableLanguages: "accept-language" in request.headers
          ? request.headers["accept-language"].split(",").map(function (s) { return s.trim(); })
          : [ "en-US", "en" ]
    });

    var sessionContext = new Capnp.Capability(new HackSessionImpl(this.grainId, this.publicId), HackSession.HackContext);
    this.session = this.uiView.newSession(
        {displayName: {defaultText: "User"}}, sessionContext,
        "0xa50711a14d35a8ce", params).session.castAs(HackSession.HackSession);
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

Proxy.prototype.close = function () {
  if (this.server) {
    this.resetConnection();
    this.server.close();
    delete this.server;

    this.getPort().then(function (port) {
      availablePorts.push(port);
    });
  }
}

Proxy.prototype.maybeRetryAfterError = function (error, retryCount) {
  // If the error may be caused by the grain dying or a network failure, try to restart it,
  // returning a promise that resolves once restarted. Otherwise, just rethrow the error.
  // `retryCount` should be incremented for every successful retry as part of the same request;
  // we only want to retry once.

  var self = this;

  // TODO(cleanup): We also have to try on osError to catch the case where connecting to the
  //   socket failed. We really ought to find a more robust way to detect that, though.
  if ("nature" in error &&
      (error.nature === "networkFailure" || error.nature === "osError") &&
      retryCount < 1) {
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
      len += buf.lenth;
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
  { id: 303, title: "See Other" },
  { id: 301, title: "Moved Permanently" },
  { id: 307, title: "Temporary Redirect" },
  { id: 308, title: "Permanent Redirect" }
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

Proxy.prototype.handleRequest = function (request, data, response, retryCount) {
  var self = this;

  return Promise.cast(undefined).then(function () {
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
      throw new Error("Sandstorm only supports GET and POST requests.");
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

      if (content.encoding) {
        response.setHeader("Content-Encoding", content.encoding);
      }
      if (content.language) {
        response.setHeader("Content-Language", content.language);
      }
      if ("bytes" in content.body) {
        response.setHeader("Content-Length", content.body.bytes.length);
      } else {
        // TODO(soon):  Implement streaming.
        throw new Error("Streaming not implemented.");
      }
      if (("disposition" in content) && ("download" in content.disposition)) {
        response.setHeader("Content-Disposition", "attachment; filename=\"" +
            content.disposition.download.replace(/([\\"\n])/g, "\\$1") + "\"");
      }

      response.writeHead(code.id, code.title, { "Content-Type": content.mimeType });

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
    rpcStream.sendBytes(chunk);
  });
  socket.on("end", function (chunk) {
    rpcStream.close();
  });
}

Proxy.prototype.handleWebSocket = function (request, socket, head, retryCount) {
  var self = this;

  return Promise.cast(undefined).then(function () {
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
  });

  // Read initial 8k tail data immediately.
  doTail();

  // Notify ready.
  this.ready();
});
