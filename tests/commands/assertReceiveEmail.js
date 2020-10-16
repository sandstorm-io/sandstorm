var util = require("util");
var events = require("events");
var MailParser = require("mailparser").MailParser;
var simplesmtp = require("simplesmtp");
var _ = require("underscore");

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

  var server;
  var timeoutHandle = setTimeout(function() {
    console.log("asesertReceiveEmail timed out.");
    server.server.end(function () {});
    // if we have a callback, call it right before the complete event
    if (cb) {
      cb.call(self.client.api, new Error("Timed out while trying to receive email"));
    } else {
      self.client.api.assert.equal("Timed out while waiting to receive email message", "");
    }

    self.emit("complete");
  }, timeout);

  var options = { SMTPBanner:"Sandstorm Testing Mail Server", timeout: 10000, disableSTARTTLS: true };
  server = simplesmtp.createSimpleServer(options, function (req) {
    var mailparser = new MailParser();

    req.pipe(mailparser);
    req.accept();
    mailparser.on("end", function (mail) {
      clearTimeout(timeoutHandle);
      server.server.end(function () {
        if (cb) {
          cb.call(self.client.api);
        }

        self.emit("complete");
      });

      var expected = expectedMessage;

      if ("to" in expected) {
        self.client.api.assert.equal(mail.to[0].address, expected.to);
        expected = _.omit(expected, "to");
      }
      Object.keys(expected).forEach(function (key) {
        self.client.api.assert.equal(mail[key], expected[key]);
      });
    });
  });

  server.listen(SMTP_OUTGOING_PORT, function (err) {
    if (err) {
      clearTimeout(timeoutHandle);
      if (cb) {
        cb.call(self.client.api, err);
      } else {
        self.client.api.assert.equal("Failed to start listening for SMTP server " + err, "");
      }
      self.emit("complete");
    } else {
      if (selector) {
        self.client.api.click(selector);
      }
    }
  });

  return this;
};

module.exports = ReceiveEmail;
