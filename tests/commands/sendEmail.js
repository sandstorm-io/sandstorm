var util = require("util");
var events = require("events");
var MailComposer = require("mailcomposer").MailComposer;
var simplesmtp = require("simplesmtp");

var SMTP_LISTEN_PORT = parseInt(process.env.SMTP_LISTEN_PORT, 10) || 30025;
var pool = simplesmtp.createClientPool(SMTP_LISTEN_PORT);

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

  var mailcomposer = new MailComposer();
  mailcomposer.setMessageOption(message);
  pool.sendMail(mailcomposer, function (err) {
    clearTimeout(timeoutHandle);
    if (cb) {
      cb.call(self.client.api, err);
    }

    pool.close();
    self.emit("complete");
  });

  return this;
};

module.exports = SendEmail;
