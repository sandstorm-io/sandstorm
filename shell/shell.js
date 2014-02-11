if (Meteor.isClient) {
  Template.hello.greeting = function () {
    return "Welcome to shell.";
  };

  Template.hello.events({
    'click input' : function () {
      // template data, if any, is available in 'this'
      if (typeof console !== 'undefined')
        console.log("You pressed the button");
    }
  });
}

if (Meteor.isServer) {
  // We don't load these until later, but prevent them fr
  var Capnp = Npm.require("sandstorm/capnp");
  var Grain = Capnp.import("sandstorm/grain.capnp");
  var WebSession = Capnp.import("sandstorm/web-session.capnp").WebSession;
  var capnpConnection;  // prevent GC

  Meteor.startup(function () {
    // code to run on server at startup
    capnpConnection = Capnp.connect("127.0.0.1:3004");
    var ui = capnpConnection.restore(null, Grain.UiView);

    // TODO(cleanup):  Auto-generate based on annotations in web-session.capnp.
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

    var params = Capnp.serialize(WebSession.Params, {
      basePath: "http://127.0.0.1:3004",
      userAgent: "DummyUserAgent/1.0",
      acceptableLanguages: [ "en-US", "en" ]
    });

    var session = ui.newSession({displayName: {defaultText: "User"}}, null,
                                "0xa50711a14d35a8ce", params).session.castAs(WebSession);

    // Set up a proxy on an alternate port from which we'll serve app content.
    // The main reason for using a separate port is so that apps are in a different
    // origin from the shell.  We additionally enable HTML sandboxing so that each
    // app should actually be in a unique throw-away origin.
    var http = Npm.require("http");
    var server = http.createServer(function (request, response) {
      console.log("request");
      session.get(request.url.slice(1), {})
          .then(function (rpcResponse) {
        // TODO(now):  Interpret cookies.
        if ("content" in rpcResponse) {
          var content = rpcResponse.content;
          var code = successCodes[content.statusCode];
          if (!code) {
            throw new Error("Unknown status code: ", content.statusCode);
          }

          var headers = {
            "Content-Type": content.mimeType,
          };
          if (content.encoding) {
            headers["Content-Encoding"] = content.encoding;
          }
          if (content.language) {
            headers["Content-Language"] = content.language;
          }
          if ("bytes" in content.body) {
            headers["Content-Length"] = content.body.bytes.length;
          } else {
            // TODO(soon):  Implement streaming.
            throw new Error("Streaming not implemented.");
          }

          response.writeHead(code.id, code.title, headers);

          if ("bytes" in content.body) {
            response.end(content.body.bytes);
          }
        } else if ("redirect" in rpcResponse) {
          var redirect = rpcResponse.redirect;
          var code = redirectHeaders[redirect.switchToGet * 2 + redirect.isPermanent];
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
        var body = error.toString();
        response.writeHead(500, "Internal Server Error", {
          "Content-Length": body.length,
          "Content-Type": "text/plain"
        });
        response.end(body);
      });
    });

    server.listen(3003);
  });
}
