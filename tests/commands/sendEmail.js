var util = require("util");
var events = require("events");
var nodemailer = require("nodemailer");

var SMTP_LISTEN_PORT = parseInt(process.env.SMTP_LISTEN_PORT, 10) || 30025;

function normalizeMessage(message) {
  var normalized = Object.assign({}, message);

  // `body` was used historically in tests; Nodemailer calls the plain-text body `text`.
  if (normalized.body && !normalized.text) {
    normalized.text = normalized.body;
    delete normalized.body;
  }

  return normalized;
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

  var transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: SMTP_LISTEN_PORT,
    secure: false,
    ignoreTLS: true,
  });
  var completed = false;

  function finish(err) {
    if (completed) return;
    completed = true;
    clearTimeout(timeoutHandle);
    transport.close();
    if (cb) {
      cb.call(self.client.api, err);
    }

    self.emit("complete");
  }

  var timeoutHandle = setTimeout(function() {
    console.log("sendEmail timed out.");
    finish(new Error("Timed out while trying to send email"));
  }, timeout);

  transport.sendMail(normalizeMessage(message), finish);
  return this;
};

module.exports = SendEmail;
