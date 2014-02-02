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
  Meteor.startup(function () {
    // code to run on server at startup
    console.log("hello");

    var Capnp = Npm.require("sandstorm/capnp");
    var Grain = Capnp.import("sandstorm/grain.capnp");
    var WebSession = Capnp.import("sandstorm/web-session.capnp").WebSession;
    var conn = Capnp.connect("127.0.0.1:3004");
    var ui = conn.restore(null, Grain.UiView);

    var params = Capnp.serialize(WebSession.Params, {
      basePath: "http://127.0.0.1:3004",
      userAgent: "DummyUserAgent/1.0",
      acceptableLanguages: [ "en-US", "en" ]
    });

    var session = ui.newSession({displayName: {defaultText: "User"}}, null,
                                "0xa50711a14d35a8ce", params).session.castAs(WebSession);

    console.log(session);

    // Set up a proxy on an alternate port from which we'll serve app content.
    // The main reason for using a separate port is so that apps are in a different
    // origin from the shell.  We additionally enable HTML sandboxing so that each
    // app should actually be in a unique throw-away origin.
    var http = Npm.require("http");
    var server = http.createServer(function (request, response) {
      console.log("request");
      session.get(request.url.slice(1), {})
          .then(function (rpcResponse) {
        if ("content" in rpcResponse) {
          var content = rpcResponse.content;
          var bytes = content.body.bytes;
          // TODO(now):  201 or 202
          response.writeHead(200, "OK", {
            "Content-Length": bytes.length,
            "Content-Type": content.mimeType
          });
          response.end(bytes);
        } else {
          // TODO(now):  Non-200 responses.
          var body = JSON.stringify(rpcResponse);
          response.writeHead(200, "OK", {
            "Content-Length": body.length,
            "Content-Type": "text/plain"
          });
          response.end(body);
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
