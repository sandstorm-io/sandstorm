// This file is used by Sandstorm to monkey-patch certain classes/functions in Nodejs
// Specifically, we're changing http.Server.listen to listen on fd=3 instead of the normal
// parameters. This is fine to do globally, since there's only ever one http server in meteor.

var http = require('http');
var https = require('https');
var net = require('net');
var fs = require('fs');

function bindListenerToMainPort() {
  // File descriptor #3 is either where we're supposed to speak Meteor
  // HTTP, or monkey-patched Meteor HTTPS, depending on the presence
  // of HTTPS_PORT.
  //
  // Note that this monkey-patches the HTTPS module from node,
  function getMainListenerIsHttps() {
    console.log("Also here is environ", process.env);

    return !!process.env.HTTPS_PORT;
  };
  if (getMainListenerIsHttps()) {
    // Then we monkey-patch http.createServer() to return a https createServer.

    function monkeypatchHttp() {
      function getHttpsOptions() {
        // This function returns an object containing 'key' and 'cert'
        // by looking in the Sandcats configuration directory for
        // the current hostname.

        // Actually it's a stub for now.
        return {
          'key': '-----BEGIN PRIVATE KEY-----\n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\nCYhTLezn43CYMhId6IH/E+VOBqz6\n-----END PRIVATE KEY-----\n',
          'cert': '-----BEGIN CERTIFICATE-----\r\nMIIGeDCCBWCgAwIBAgIQMvEFlcrw7X8kOaX+gVUoHTANBgkqhkiG9w0BAQUFADB/\r\nMQswCQYDVQQGEwJCRTEfMB0GA1UECxMWRm9yIFRlc3QgUHVycG9zZXMgT25seTEZ\r\nMBcGA1UEChMQR2xvYmFsU2lnbiBudi1zYTE0MDIGA1UEAxMrR2xvYmFsU2lnbiBP\r\ncmdhbml6YXRpb24gVmFsaWRhdGlvbiBDQVQgLSBHMjAeFw0xNTA5MTAyMzE4MDFa\r\nFw0xNTA5MjAwNDU5NTlaMIGNMQswCQYDVQQGEwJVUzETMBEGA1UECBMKQ2FsaWZv\r\ncm5pYTESMBAGA1UEBxMJUGFsbyBBbHRvMSowKAYDVQQKEyFTYW5kc3Rvcm0gRGV2\r\nZWxvcG1lbnQgR3JvdXAsIEluYy4xKTAnBgNVBAMTIGxhcHRvcC5zYW5kY2F0cy1k\r\nZXYuc2FuZHN0b3JtLmlvMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA\r\nyqkiv6BiKwDu3uHk+ZIESqhxv9g2QncdeTG9QAislFRpJjmME5djgNebFT9vinpI\r\nL2OVKTMMFNTDf58bch01TJIBjMVIQE5S1qn8bpkm29yc4J3RKT/kirqmHhSGtFPN\r\nlsdQ6zaJMro+E1go/iWiBp+S9n261HW8ywnubr0tu49npiVTQQBY1FeJREHrf4gG\r\n5M84iW96Pe1bjaKGVk+a0RR0cPU9TrDY917Xo7hCaiGIctbsNcgB92LbdD8L4h9H\r\nStf2GZYJ1GOaDHfe4m8gd4785utamUSewj73mGSr5u9VPExYe+3Oyf5PaP6Jm8YX\r\nT0xc0EeNvGytkqbDNoH+vWvtnFNEHjXO8+7SYIcnbEQ/r92dU46jxwSergsDrJsk\r\n2ZuFYOpvWwPFf1YtfK61ckGQzdLriklh4hqic66fBXhnyD0X+Pq9xc0jZgH4QSXa\r\nqlxwBbsKmJhaIy8zpLUa+paDr8BPzaxl73bFER1Or8cjoLsib1b8IqPYCVUOaZsB\r\niESjIxHFav5UJDELCP6F+DJHgMQfcsTErdeVcS4WjtERndWSJjG5k8b7UcN/gqLv\r\nRmfpmfUioTJRbQs5q1ZNkwnIcvVhxeflNAIE7qNHCPLeGL/+7S9uG5iweD2vwvCf\r\nxv2hZCDUzXGH8KhMWn/5EZKOmkXCcOoE8aquzX98iGcCAwEAAaOCAd8wggHbMA4G\r\nA1UdDwEB/wQEAwIFoDBJBgNVHSAEQjBAMD4GBmeBDAECAjA0MDIGCCsGAQUFBwIB\r\nFiZodHRwczovL3d3dy5nbG9iYWxzaWduLmNvbS9yZXBvc2l0b3J5LzArBgNVHREE\r\nJDAigiBsYXB0b3Auc2FuZGNhdHMtZGV2LnNhbmRzdG9ybS5pbzAJBgNVHRMEAjAA\r\nMB0GA1UdJQQWMBQGCCsGAQUFBwMBBggrBgEFBQcDAjBIBgNVHR8EQTA/MD2gO6A5\r\nhjdodHRwOi8vY3JsLmdsb2JhbHNpZ24uY29tL2dzL2dzb3JnYW5pemF0aW9udmFs\r\nY2F0ZzIuY3JsMIGcBggrBgEFBQcBAQSBjzCBjDBKBggrBgEFBQcwAoY+aHR0cDov\r\nL3NlY3VyZS5nbG9iYWxzaWduLmNvbS9jYWNlcnQvZ3Nvcmdhbml6YXRpb252YWxj\r\nYXRnMi5jcnQwPgYIKwYBBQUHMAGGMmh0dHA6Ly9vY3NwMi5nbG9iYWxzaWduLmNv\r\nbS9nc29yZ2FuaXphdGlvbnZhbGNhdGcyMB0GA1UdDgQWBBRo0Z58U8EOoB9hM8U9\r\ndHm3AV/ArzAfBgNVHSMEGDAWgBTAgBLvJedUyPoCSeL3b9+0qwQerzANBgkqhkiG\r\n9w0BAQUFAAOCAQEAn56qkX9AlmjSqPx2SQS/Yfex5M6uAXYfMzgKvR051/WKbQpc\r\nzLLWXs8osvScBNfy4ZcAkQ/GqzV9nPcCkLaeZKhzvPjNmI0SIO1TEN8zm3aE6YXb\r\nP4g7yu2RFOBl3zIQc94AlSDkvPtliQrYjwuGPHBq3CBiyVgo6JUvEG/siJC1CtTl\r\n7JWAeECDkf/O878yJ+LtMmjscMqHkWb8OkGfWhhb49qdedkXjK4HqeSU8kfOfcqd\r\n/m4aiFLBp9mkNgeytO3OtGXJyq60y3b5bIcAF5Zm0NerDMPqmymN1ZWmU8DhztRr\r\no9BQg4aQebDmCgg/fhdmyV6/UKwjSPrdOFq/Ig==\r\n-----END CERTIFICATE-----'
        };
      };

      // This function monkey-patches two parts of the 'http' module:
      //
      // - createServer, so that we can add HTTPS certificate info, and
      //
      // - listen, so we can listen on a file descriptor rater than a port.

      var fakeHttpCreateServer = function(app) {
        console.log('fakeHttpCreateServer: function starts');
        var httpsServer = https.createServer(getHttpsOptions(), app);

        // Meteor (at least version 1.1 and earlier) calls
        // httpServer.setTimeout(), which sets a default socket
        // timeout. This method is not available on the nodejs v. 0.10.x httpsServer.
        //
        // Upon actually receiving a connection, Meteor adjusts the
        // timeouts, and since those operations occur on a It then, upon
        // actually receiving a connection, adjusts the socket timeouts.
        httpsServer.setTimeout = function(timeout) {
          console.log("httpsServer via fakeHttpCreateServer: Ignoring timeout!");
        };

        // Provide a modified listen() function that ignores port & host
        // and binds to file descriptor 3.

        var oldListen = https.Server.prototype.listen;
        httpsServer.listen = function (port, host, cb) {
          oldListen.call(this, {fd: 3}, cb);
        }

        console.log('fakeHttpCreateServer: function ends');
        return httpsServer;
      }

      // Stash the original http.createServer somewhere, in case someone
      // needs it later. Then replace it.
      http._oldCreateServer = http.createServer;
      http.createServer = fakeHttpCreateServer;
    };

    /* This is node code that is a proof of concept for how we're
     * going to mock out enough things so you can run a HTTPS
     * service via calls to a HTTP server setup.
     */
    monkeypatchHttp();
  } else {
    // Monkey-patch http.createServer() so it listens on FD #3.
    var oldListen = http.Server.prototype._oldListen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (port, host, cb) {
      oldListen.call(this, {fd: 3}, cb);
    }
  }
}

function bindListenerToAlternatePorts() {
  // File descriptors #4, 5, 6, ... are alternate ports that exist
  // for us to serve HTTP redirects on. The redirects send users
  // to the real Sandstorm BASE_URL plus any path component the visitor
  // has supplied.
  //
  // This redirection serves a useful purpose: if a Sandstorm install
  // previously used port 6080, but now they use port 80, the redirect
  // makes their old links work. Similarly if they switch from port
  // 6080 to HTTPS on port 443.
  //
  // This file runs its own HTTP redirect daemon, rather than ask
  // e.g. Meteor to do this, because (at the time of writing) Meteor
  // is designed to speak on just one port.
  //
  // We look at the PORTS config option to determine how many of these
  // to listen on.
  function getNumberOfAlternatePorts() {
    var numCommas = (process.env.PORT.match(/,/g) || {}).length;
    var numPorts = numCommas + 1;
    var numAlternatePorts = numPorts - 1;
    console.log('omgyay', numAlternatePorts);
    return numAlternatePorts;
  };

  for (var i = 0; i < getNumberOfAlternatePorts(); i++) {
    // Load the http module to create an http server.
    var http = require('http');

    // Configure our HTTP server to redirect to base URL
    var server = http.createServer(function (request, response) {
      console.log(request);
      response.writeHead(302, {"Location": process.env.ROOT_URL + request.url});
      response.end();
    });

    server.listen({fd: i + 4});
  }

}

bindListenerToAlternatePorts();
bindListenerToMainPort();

require("./main.js");
