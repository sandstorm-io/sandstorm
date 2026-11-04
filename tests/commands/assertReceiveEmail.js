var util = require("util");
var events = require("events");
var simpleParser = require("mailparser").simpleParser;
var SMTPServer = require("smtp-server").SMTPServer;

var SMTP_OUTGOING_PORT = parseInt(process.env.SMTP_OUTGOING_PORT, 10) || 30026;

function ReceiveEmail() {
  events.EventEmitter.call(this);
}

util.inherits(ReceiveEmail, events.EventEmitter);

ReceiveEmail.prototype.command = function(selector, expectedMessage, timeout, cb) {
  var self = this;
  if (timeout instanceof Function) {
    cb = timeout;
    timeout = undefined;
  }
  timeout = timeout || 10000;

  var completed = false;
  var server;

  function finish(err) {
    if (completed) return;
    completed = true;
    clearTimeout(timeoutHandle);

    function report() {
      if (cb) {
        cb.call(self.client.api, err);
      } else if (err) {
        self.client.api.assert.equal(err.message, "");
      }

      self.emit("complete");
    }

    if (server && server.server && server.server.listening) {
      server.close(report);
    } else {
      report();
    }
  }

  var timeoutHandle = setTimeout(function() {
    console.log("assertReceiveEmail timed out.");
    finish(new Error("Timed out while waiting to receive email message"));
  }, timeout);

  server = new SMTPServer({
    banner: "Sandstorm Testing Mail Server",
    socketTimeout: 10000,
    disabledCommands: ["AUTH", "STARTTLS"],
    onData: function(stream, _session, done) {
      simpleParser(stream).then(function(mail) {
        var expected = Object.assign({}, expectedMessage);

        if ("to" in expected) {
          self.client.api.assert.equal(mail.to.value[0].address, expected.to);
          delete expected.to;
        }

        Object.keys(expected).forEach(function(key) {
          self.client.api.assert.equal(mail[key], expected[key]);
        });

        done();
        finish();
      }).catch(function(err) {
        done(err);
        finish(new Error("Failed to parse received email: " + err));
      });
    },
  });

  server.on("error", finish);
  server.listen(SMTP_OUTGOING_PORT, "127.0.0.1", function() {
    if (selector) {
      self.client.api.click(selector);
    }
  });

  return this;
};

module.exports = ReceiveEmail;
