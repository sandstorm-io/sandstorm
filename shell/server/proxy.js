// We don't load these until later, but prevent them fr
var Capnp = Npm.require("sandstorm/capnp");
var Crypto = Npm.require("crypto");
var ChildProcess = Npm.require("child_process");
var Fs = Npm.require("fs");
var Path = Npm.require("path");
var Promise = Npm.require("es6-promise").Promise;

var Grain = Capnp.import("sandstorm/grain.capnp");
var WebSession = Capnp.import("sandstorm/web-session.capnp").WebSession;
var GRAINDIR = "/var/sandstorm/grains";

var runningGrains = {};

var inMeteor = Meteor.bindEnvironment(function (callback) { callback(); });

function getGrain(grainid) {
  return new Promise(function (resolve, reject) {
    inMeteor(function () {
      var grain = Grains.findOne({grainid: grainid});
      if (grain) {
        var app = Apps.findOne({appid: grain.appid});
        if (app) {
          resolve({app: app, grain: grain});
        } else {
          reject(new Error("No such app."));
        }
      } else {
        reject(new Error("No such grain."));
      }
    });
  });
};

newGrain = function (appid, command) {
  var grainid = Random.id();
  // TODO(soon):  Better default title?  Prompt user?
  Grains.insert({ appid: appid, grainid: grainid, title: "New Object" });
  try {
    startGrain(appid, grainid, command, true).catch(function (err) {
      console.error(err.stack);
    });
  } catch (err) {
    console.error(err.stack);
  }
}

function startGrain(appid, grainid, command, isNew) {
  if (grainid in runningGrains) {
    // Don't start again.
    return runningGrains[grainid].whenReady;
  }

  var args = [appid, grainid];
  if (isNew) args.push("-n");
  for (var i in command.environ) {
    args.push(["-e", command.environ[i].key, "=", command.eviron[i].value].join(""));
  }

  args.push("--");
  args.push(command.executablePath);
  args = args.concat(command.args);

  console.log(args);

  var proc = ChildProcess.spawn("sandstorm-supervisor", args, {
    // TODO(soon): Make sure supervisor doesn't pass stdio raw into the grain.
    stdio: ["ignore", "pipe", process.stderr]
  });
  proc.on("error", function () {});
  proc.on("exit", function () {
    delete runningGrains[grainid];
  });

  // TODO(soon):  Wait for activity on stdin to indicate the server is listening.

  var grain = {
    proc: proc,
    whenReady: new Promise(function (resolve, reject) {
      var gotData = false;
      proc.stdout.on("data", function () {
        if (!gotData) {
          gotData = true;
          resolve();
        }
      });
      proc.stdout.on("end", function () {
        if (!gotData) {
          reject(new Error("Grain never came up."));
        }
      });
    })
  };
  runningGrains[grainid] = grain;

  return grain.whenReady;
}

function killGrain (grainid) {
  var grain = runningGrains[grainid];
  if (grain) {
    // TODO(soon): Supervisor needs to respond to SIGTERM by SIGKILLing everything under it.
    grain.proc.kill("SIGTERM");
  }
}

function startRequest(request) {
  try {
    // TODO(soon):  Open a new session for each connected client, probably via the Meteor session
    //   manager.  They should all use the same connection, though.

    var path = request.url.split("/");
    if (path[0] !== "") {
      throw new Error("request.url did not start with /?");
    }

    if (path.length < 3) {
      throw new Error("Missing grain and session IDs.");
    }

    var grainid = path[1];
    var sessionid = path[2];

    function makeSession(connection) {
      var ui = connection.restore(null, Grain.UiView);

      var params = Capnp.serialize(WebSession.Params, {
        basePath: "http://127.0.0.1:3004",
        userAgent: "user-agent" in request.headers
            ? request.headers["user-agent"]
            : "UnknownAgent/0.0",
        acceptableLanguages: "accept-language" in request.headers
            ? request.headers["accept-language"].split(",").map(function (s) { return s.trim(); })
            : [ "en-US", "en" ]
      });
      sessions[sessionid] = ui.newSession(
          {displayName: {defaultText: "User"}}, null,
          "0xa50711a14d35a8ce", params).session.castAs(WebSession);
    }

    var promise;
    if (sessionid in sessions) {
      promise = Promise.cast(undefined);
    } else if (grainid in connections) {
      makeSession(connections[grainid]);
      promise = Promise.cast(undefined);
    } else {
      promise = getGrain(grainid).then(function (info) {
        return startGrain(info.app.appid, grainid, info.app.manifest.continueCommand)
            .then(function () {
          var connection = Capnp.connect("unix:" + Path.join(GRAINDIR, grainid, "socket"));
          connections[grainid] = connection;  // prevent GC
          makeSession(connection);
        });
      });
    }

    return promise.then(function () {
      return {
        path: path.slice(3).join("/"),
        session: sessions[sessionid],
        dropSession: function () {
          delete sessions[sessionid];
        }
      };
    });
  } catch (err) {
    return Promise.reject(err);
  }
}

var successCodes = {
  ok:       { id: 200, title: "OK" },
  created:  { id: 201, title: "Created" },
  accepted: { id: 202, title: "Accepted" }
};
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

function parseCookies(header) {
  var result = [];
  var reqCookies = header.split(";");
  for (var i in reqCookies) {
    var reqCookie = reqCookies[i];
    var equalsPos = reqCookie.indexOf("=");
    if (equalsPos == -1) {
      result.push({key: reqCookie.trim(), value: ""});
    } else {
      result.push({key: reqCookie.slice(0, equalsPos).trim(),
                   value: reqCookie.slice(equalsPos + 1)});
    }
  }
  return result;
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

function readAll(stream, callback) {
  var buffers = [];
  var len = 0;

  stream.on("data", function (buf) {
    buffers.push(buf);
    len += buf.lenth;
  });
  stream.on("end", function () {
    callback(Buffer.concat(buffers), len);
  });
}

function WebSocketReceiver(socket) {
  var queue = [];
  this.go = function () {
    queue = null;
    for (var i in queue) {
      socket.write(queue[i]);
    }
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

var sessions = {};
var connections = {};

Meteor.startup(function () {
  // code to run on server at startup

  // TODO(cleanup):  Auto-generate based on annotations in web-session.capnp.

  function handleRequest(request, data, response, retryCount) {
    startRequest(request).then(function (requestInfo) {
      var context = {};
      var session = requestInfo.session;
      if ("cookie" in request.headers) {
        context.cookies = parseCookies(request.headers.cookie);
      }

      var promise;
      if (request.method === "GET") {
        promise = session.get(requestInfo.path, context);
      } else if (request.method === "POST") {
        promise = session.post(requestInfo.path, {
            mimeType: request.headers["mime-type"],
            content: data
          }, context);
      } else {
        throw new Error("Sandstorm only supports GET and POST requests.");
      }

      promise.then(function (rpcResponse) {
        if (rpcResponse.setCookies.length > 0) {
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

          response.writeHead(code.id, code.title, { "Content-Type": content.mimeType });

          if ("bytes" in content.body) {
            response.end(content.body.bytes);
          }
        } else if ("redirect" in rpcResponse) {
          var redirect = rpcResponse.redirect;
          var code = redirectCodes[redirect.switchToGet * 2 + redirect.isPermanent];
          response.writeHead(code.id, code.title, {
            "Location": redirect.location
          });
          response.end();
        } else if ("clientError" in rpcResponse) {
          var clientError = rpcResponse.clientError;
          var code = errorCodes[clientError.statusCode];
          if (!code) {
            throw new Error("Unknown status code: ", clientError.statusCode);
          }
          response.writeHead(code.id, code.title, {
            "Content-Type": "text/html"
          });
          // TODO(soon):  Better error page.
          response.end("<html><body>" + clientError.descriptionHtml + "</body></html>");
        } else if ("serverError" in rpcResponse) {
          response.writeHead(500, "Internal Server Error", {
            "Content-Type": "text/html"
          });
          // TODO(soon):  Better error page.
          response.end("<html><body>" + rpcResponse.serverError.descriptionHtml + "</body></html>");
        } else {
          throw new Error("Unknown HTTP response type:\n" + JSON.stringify(rpcResponse));
        }
      }).catch(function (error) {
        if ("nature" in error && error.nature === "networkFailure" && retryCount < 1) {
          // Reconnect.
          requestInfo.dropSession();
          handleRequest(request, data, response, retryCount + 1);
          return;
        } else {
          var body = error.toString() + "\n" +
              "location: " + (error.cppFile || "(unknown)") + ":" + (error.line || "??") + "\n" +
              "type: " + (error.durability || "") + " " + (error.nature || "(unknown)");
          response.writeHead(500, "Internal Server Error", {
            "Content-Length": body.length,
            "Content-Type": "text/plain"
          });
          response.end(body);
        }
      });
    }).catch(function (err) {
      console.error(err.stack);
      response.writeHead(500, {"Content-Type": "text/plain"});
      response.end(err.stack);
    });
  }

  // Set up a proxy on an alternate port from which we'll serve app content.
  // The main reason for using a separate port is so that apps are in a different
  // origin from the shell.  We additionally enable HTML sandboxing so that each
  // app should actually be in a unique throw-away origin.
  var http = Npm.require("http");
  var server = http.createServer(function (request, response) {
    readAll(request, function (data) {
      handleRequest(request, data, response, 0);
    });
  });

  server.on("upgrade", function (request, socket, head) {
    startRequest(request).then(function (requestInfo) {
      var session = requestInfo.session;

      if (!("sec-websocket-key" in request.headers)) {
        throw new Error("Missing Sec-WebSocket-Accept header.");
      }

      var magic = request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
      var acceptKey = Crypto.createHash("sha1").update(magic).digest("base64");

      var context = {};
      if ("cookie" in request.headers) {
        context.cookies = parseCookies(request.headers.cookie);
      }

      var protocols = [];
      if ("sec-websocket-protocol" in request.headers) {
        protocols = request.headers["sec-websocket-protocol"]
            .split(",").map(function (s) { return s.trim(); });
      }

      var receiver = new WebSocketReceiver(socket);

      var promise = session.openWebSocket(requestInfo.path, context, protocols, receiver);

      if (head.length > 0) {
        promise.serverStream.sendBytes(head);
      }
      pumpWebSocket(socket, promise.serverStream);

      promise.then(function (response) {
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
      }).catch (function (error) {
        // TODO(now):  Check for network error and retry like with regular requests.
        console.error("WebSocket setup failed:", error);
        socket.close();
      });
    });
  });

  server.listen(3003);
});
