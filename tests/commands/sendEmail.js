var util = require("util");
var events = require("events");
var MailComposer = require("mailcomposer");
var simplesmtp = require("simplesmtp");

var SMTP_LISTEN_PORT = parseInt(process.env.SMTP_LISTEN_PORT, 10) || 30025;
var pool = simplesmtp.createClientPool(SMTP_LISTEN_PORT);

function normalizeMessage(message) {
  var normalized = {};
  Object.keys(message || {}).forEach(function (key) {
    normalized[key] = message[key];
  });

  // `body` was used historically in tests; modern mailcomposer expects `text`.
  if (normalized.body && !normalized.text) {
    normalized.text = normalized.body;
    delete normalized.body;
  }

  return normalized;
}

function buildMail(message, cb) {
  var normalized = normalizeMessage(message);
  var compiled = MailComposer(normalized);

  if (!compiled || typeof compiled.build !== "function" || typeof compiled.getEnvelope !== "function") {
    cb(new Error("mailcomposer v4 API unavailable"));
    return;
  }

  var envelope = compiled.getEnvelope();

  compiled.build(function (err, rawMessage) {
    if (err) {
      cb(err);
      return;
    }

    cb(null, {
      getEnvelope: function () {
        return envelope;
      },
      streamMessage: function () {},
      pipe: function (connection) {
        connection.write(rawMessage);
        connection.end();
      },
    });
  });
}

function SendEmail() {
  events.EventEmitter.call(this);
}

util.inherits(SendEmail, events.EventEmitter);

SendEmail.prototype.command = function(message, timeout, cb) {
  var self = this;
  if (timeout instanceof Function) {
    cb = timeout;
    timeout = undefined;
  }
  timeout = timeout || 10000;

  var timeoutHandle = setTimeout(function() {
    console.log("sendEmail timed out.");
    // if we have a callback, call it right before the complete event
    if (cb) {
      cb.call(self.client.api, new Error("Timed out while trying to send email"));
    }

    pool.close();
    self.emit("complete");
  }, timeout);

  buildMail(message, function (buildErr, mailcomposer) {
    if (buildErr) {
      clearTimeout(timeoutHandle);
      if (cb) {
        cb.call(self.client.api, buildErr);
      }
      pool.close();
      self.emit("complete");
      return;
    }

    pool.sendMail(mailcomposer, function (err) {
      clearTimeout(timeoutHandle);
      if (cb) {
        cb.call(self.client.api, err);
      }

      pool.close();
      self.emit("complete");
    });
  });

  return this;
};

module.exports = SendEmail;
