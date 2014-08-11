// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var Http = Npm.require("http");
var Https = Npm.require("https");
var Future = Npm.require("fibers/future");

var EmailRpc = Capnp.importSystem("sandstorm/email.capnp");
var HackSessionContext = Capnp.importSystem("sandstorm/hack-session.capnp").HackSessionContext;
var Supervisor = Capnp.importSystem("sandstorm/supervisor.capnp").Supervisor;
var EmailMessage = EmailRpc.EmailMessage;
var EmailSendPort = EmailRpc.EmailSendPort;

var Url = Npm.require("url");

var ROOT_URL = Url.parse(process.env.ROOT_URL);
var HOSTNAME = ROOT_URL.hostname;

var DAILY_LIMIT = 50;
var RECIPIENT_LIMIT = 20;

var dailySendCounts = {};
// Maps user IDs to counts of the number of e-mails they have sent today.

var CLIENT_TIMEOUT = 15000; // 15s

Meteor.setInterval(function () { dailySendCounts = {}; }, 86400);

Meteor.startup(function() {
  var SANDSTORM_SMTP_PORT = parseInt(process.env.SANDSTORM_SMTP_PORT, 10) || 30025;

  simplesmtp.createSimpleServer({SMTPBanner:"Sandstorm Mail Server"}, function (req) {
    var mailparser = new MailParser();
    var bufs = [];

    req.pipe(mailparser);
    mailparser.on('end', function (mail) {
      // Wrap in outer promise for easier error handling.
      Promise.resolve().then(function () {
        // Extract the "from" address.
        var from;
        if (mail.from && mail.from.length > 0) {
          // It's theoretically possible for the message to have multiple "from" headers, but this
          // never really happens in legitimate practice so we'll just take the first one.
          from = mail.from[0];
        } else {
          // The mail body is missing a "From:" header. We'll use req.from instead. Note that
          // req.from is actually the bounce address, which is sometimes *not* the original sender
          // but rather some intermediate agent (e.g. a mailing list daemon). See:
          //   http://en.wikipedia.org/wiki/Bounce_address
          // TODO(someday): Is this really right, or should we report a blank address instead?
          from = { address: req.from, name: false };
        }

        var attachments = [];
        if (mail.attachments) {
          attachments = mail.attachments.map(function (attachment) {
            var disposition = attachment.contentDisposition || "attachment";
            disposition += ';\n\tfilename="' + (attachment.fileName || attachment.generatedFileName) + '"';
            return {
              contentType: attachment.contentType,
              contentDisposition: disposition,
              contentId: attachment.contentId,
              content: attachment.content
            };
          });
        }

        var mailMessage = {
          // Note that converting the date to nanoseconds actually goes outside the range of
          // integers that Javascript can represent precisely. But this is OK because dates aren't
          // precise anyway.
          date: (mail.date || new Date()).getTime() * 1000000,
          from: from,
          to: mail.to,
          cc: mail.cc || [],
          bcc: mail.bcc || [],
          replyTo: mail.headers['reply-to'] || {},
          messageId: mail.headers['message-id'] || Meteor.uuid() + '@' + HOSTNAME,
          references: mail.references || [],
          inReplyTo: mail.inReplyTo || [],
          subject: mail.subject || '',
          text: mail.text || null,
          html: mail.html || null,
          attachments: attachments
        };

        // Get list of grain IDs.
        var grainPublicIds = _.uniq(req.to.map(function (deliverTo) {
          // simplesmtp already validates that the address contains an @.
          // To simplify things, we ignore the hostname part of the address and assume that the
          // message would not have been sent here if it weren't intended for our host. Usually
          // there will be an nginx frontend verifying hostnames anyway. Grain public IDs are
          // globally unique anyway, so an e-mail meant for another server presumably won't match
          // any ID at this one anyway.
          return deliverTo.slice(0, deliverTo.indexOf('@'));
        }));

        // Deliver to each grain in parallel.
        return Promise.all(grainPublicIds.map(function (publicId) {
          // Wrap in a function so that we can call it recursively to retry.
          function tryDeliver(retryCount) {
            var grainId;
            return inMeteor(function () {
              var grain = Grains.findOne({publicId: publicId}, {fields: {}});
              if (grain) {
                grainId = grain._id;
                return openGrain(grainId, retryCount > 0);
              } else {
                // TODO(someday): We really ought to rig things up so that the "RCPT TO" SMTP command
                //   fails in this case, but simplesmtp doesn't appear to support that.
                throw new Error("No such grain: " + publicId);
              }
            }).then(function (connection) {
              var supervisor = connection.restore(null, Supervisor);
              var uiView = supervisor.getMainView().view;

              // Create an arbitrary struct to use as the session params. E-mail sessions actually
              // require no params, but node-capnp won't let us pass null and we don't have an
              // EmptyStruct type available, so we just use EmailAddress, but any struct type would
              // work.
              // TODO(cleanup): Fix node-capnp to accept null.
              var emptyParams = Capnp.serialize(EmailRpc.EmailAddress, {});

              // Create a new session of type HackEmailSession. This is a short-term hack until
              // persistent capabilities and the Powerbox are implemented. A session of type
              // HackEmailSession expects a HackSessionContext and the session context and does not
              // take any session parameters.
              var session = uiView
                  .newSession({}, makeHackSessionContext(grainId),
                              "0xc3b5ced7344b04a6", emptyParams)
                  .session.castAs(EmailSendPort);
              return session.send(mailMessage);
            }).catch(function (err) {
              if (shouldRestartGrain(err, retryCount)) {
                return tryDeliver(retryCount + 1);
              } else {
                throw err;
              }
            });
          }
          return tryDeliver(0);
        }));
      }).then(function () {
        req.accept();
      }, function (err) {
        console.error("E-mail delivery failure:", err.stack);
        req.reject(err.message);
      });
    });
  }).listen(SANDSTORM_SMTP_PORT);
});

function formatAddress(field) {
  if (!field) {
    return null;
  }

  if (Array.isArray(field)) {
    return field.map(formatAddress);
  }

  if (field.name) {
    return field.name + ' <' + field.address + '>';
  }

  return field.address;
};

function HackSessionContextImpl(grainId) {
  this.grainId = grainId;
}

makeHackSessionContext = function (grainId) {
  return new Capnp.Capability(new HackSessionContextImpl(grainId), HackSessionContext);
}

var HOSTNAME_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

generateRandomHostname = function(length) {
  // Generate a random unique name suitable for use in a hostname.

  var digits = [];
  for (var i = 0; i < length; i++) {
    digits[i] = Random.choice(HOSTNAME_CHARS);
  }
  return digits.join("");
}

HackSessionContextImpl.prototype._getPublicId = function () {
  // Get the grain's public ID, assigning a new one if it doesn't yet have one.
  //
  // Must be called in a Meteor context.

  while (!this.publicId) {
    // We haven't looked up the public ID yet.
    var grain = Grains.findOne(this.grainId, {fields: {publicId: 1, userId: 1}});
    if (!grain) throw new Error("Grain does not exist.");

    this.userId = grain.userId;

    if (grain.publicId) {
      this.publicId = grain.publicId;
    } else {
      // The grain doesn't have a public ID yet. Generate one.
      var candidate = generateRandomHostname(20);

      if (Grains.findOne({publicId: candidate})) {
        // This should never ever happen.
        console.error("CRITICAL PROBLEM: Public ID collision. " +
                      "CSPRNG is bad or has insufficient entropy.");
        continue;
      }

      // Carefully perform an update that becomes a no-op if anyone else has assigned a public ID
      // simultaneously.
      if (Grains.update({_id: this.grainId, publicId: { $exists: false }},
                        { $set: { publicId: candidate } }) > 0) {
        // We won the race.
        this.publicId = candidate;
      }
    }
  }

  return this.publicId;
}

HackSessionContextImpl.prototype._getAddress = function () {
  // Get the grain's outgoing e-mail address.
  //
  // Must be called in a Meteor context.

  return this._getPublicId() + '@' + HOSTNAME;
}

HackSessionContextImpl.prototype._getUserAddress = function () {
  // Get the user's e-mail address.
  //
  // Must be called in a Meteor context.

  var grain = Grains.findOne(this.grainId, {fields: {userId: 1}});
  var user = Meteor.users.findOne(grain.userId);

  var email = (user.emails && user.emails.length && user.emails[0].address) || (user.services.google && user.services.google.email) || (user.services.github && user.services.github.email);

  var result = {};
  if (email) {
    result.address = email;
  }
  if (user.profile.name) {
    result.name = user.profile.name;
  }

  return result;
}

HackSessionContextImpl.prototype.send = function (email) {
  return inMeteor((function() {
    var recipientCount = 0;
    recipientCount += email.to ? email.to.length : 0;
    recipientCount += email.cc ? email.cc.length : 0;
    recipientCount += email.bcc ? email.bcc.length : 0;
    if (recipientCount > RECIPIENT_LIMIT) {
      throw new Error(
          "Sorry, Sandstorm currently only allows you to send an e-mail to " + RECIPIENT_LIMIT +
          " recipients at a time, for spam control. Consider setting up a mailing list. " +
          "Please feel free to contact us if this is a problem for you.");
    }

    // Overwrite the "from" address with the grain's address.
    if (!email.from) {
      email.from = {};
    }
    
    var grainAddress = this._getAddress();
    var userAddress = this._getUserAddress();
    
    // First check if we're changing the from address, and if so, move it to reply-to
    if (email.from.address !== grainAddress && email.from.address !== userAddress.address) {
      throw new Error(
        "FROM header in outgoing emails need to equal either " + grainAddress + " or " +
        userAddress.address + ". Yours was: " + email.from.address);
    }

    var mc = new MailComposer();

    mc.setMessageOption({
      from:     formatAddress(email.from),
      to:       formatAddress(email.to),
      cc:       formatAddress(email.cc),
      bcc:      formatAddress(email.bcc),
      replyTo:  formatAddress(email.replyTo),
      subject:  email.subject,
      text:     email.text,
      html:     email.html
    });

    var envelope = mc.getEnvelope();
    envelope.from = grainAddress;

    mc.setMessageOption({
      envelope: envelope
    });

    var headers = {};
    if (email.messageId) {
      mc.addHeader('message-id', email.messageId);
    }
    if (email.references) {
      mc.addHeader('references', email.references);
    }
    if (email.messageId) {
      mc.addHeader('in-reply-to', email.inReplyTo);
    }
    if (email.date) {
      var date = new Date(email.date / 1000000);
      if (!isNaN(date.getTime())) { // Check to make sure date is valid
        mc.addHeader('date', date.toUTCString());
      }
    }

    if (email.attachments) {
      email.attachments.forEach(function (attachment) {
        mc.addAttachment({
          cid: attachment.contentId,
          contentType: attachment.contentType,
          contentDisposition: attachment.contentDisposition,
          contents: attachment.content
        });
      });
    }

    if (!(this.userId in dailySendCounts)) {
      dailySendCounts[this.userId] = 0;
    }
    var sentToday = ++dailySendCounts[this.userId];
    if (sentToday > DAILY_LIMIT) {
      throw new Error(
          "Sorry, you've reached your e-mail sending limit for today. Currently, Sandstorm " +
          "limits each user to " + DAILY_LIMIT + " e-mails per day for spam control reasons. " +
          "Please feel free to contact us if this is a problem.");
    }

    getSmtpPool()._future_wrapped_sendMail(mc).wait();
  }).bind(this)).catch(function (err) {
    console.error("Error sending e-mail:", err.stack);
    throw err;
  });
};

HackSessionContextImpl.prototype.getPublicId = function() {
  return inMeteor((function () {
    var result = {};

    result.publicId = this._getPublicId();
    result.hostname = HOSTNAME;
    result.autoUrl = ROOT_URL.protocol + "//" + makeWildcardHost(result.publicId);

    var grain = Grains.findOne(this.grainId, {fields: {userId: 1}});
    result.isDemoUser = Meteor.users.findOne(grain.userId).expires ? true : false;

    return result;
  }).bind(this));
};

HackSessionContextImpl.prototype.httpGet = function(url) {
  var session = this;

  return new Promise(function (resolve, reject) {
    var requestMethod = Http.request;
    if (url.indexOf('https://') === 0) {
      requestMethod = Https.request;
    } else if (url.indexOf('http://') !== 0) {
      err = new Error("Protocol not recognized.");
      err.nature = "precondition";
      reject(err);
    }
    req = requestMethod(url, function (resp) {
      var buffers = [];
      var err;

      switch (Math.floor(resp.statusCode / 100)) {
        case 2:
          // 2xx response -- OK.
          resp.on('data', function (buf) {
            buffers.push(buf);
          });

          resp.on('end', function() {
            resolve({
              content: Buffer.concat(buffers),
              mimeType: resp.headers['content-type'] || null
            });
          });
          break;
        case 3:
          // 3xx response -- redirect.
          resolve(session.httpGet(resp.headers.location));
          break;
        case 4:
          // 4xx response -- client error.
          err = new Error("Status code " + resp.statusCode + " received in response.");
          err.nature = "precondition";
          reject(err);
          break;
        case 5:
          // 5xx response -- internal server error.
          err = new Error("Status code " + resp.statusCode + " received in response.");
          err.nature = "localBug";
          reject(err);
          break;
        default:
          // ???
          err = new Error("Invalid status code " + resp.statusCode + " received in response.");
          err.nature = "localBug";
          reject(err);
          break;
      }
    });

    req.on('error', function (e) {
      e.nature = "networkFailure";
      reject(e);
    });

    req.setTimeout(15000, function () {
      req.abort();
      err = new Error("Request timed out.");
      err.nature = "localBug";
      err.durability = "overloaded";
      reject(err);
    });

    req.end();
  });
};

HackSessionContextImpl.prototype.getUserAddress = function() {
  return inMeteor((function () {
    return this._getUserAddress();
  }).bind(this));
};

// =======================================================================================
// makeSmtpPool and getSmtpPool are lifted from the Meteor email package (MIT license)

var makeSmtpPool = function (mailUrlString) {
  var mailUrl = Url.parse(mailUrlString);
  if (mailUrl.protocol !== 'smtp:')
    throw new Error("Email protocol in $MAIL_URL (" +
                    mailUrlString + ") must be 'smtp'");

  var port = +(mailUrl.port);
  var auth = false;
  if (mailUrl.auth) {
    var parts = mailUrl.auth.split(':', 2);
    auth = {user: parts[0] && decodeURIComponent(parts[0]),
            pass: parts[1] && decodeURIComponent(parts[1])};
  }

  var pool = simplesmtp.createClientPool(
    port,  // Defaults to 25
    mailUrl.hostname,  // Defaults to "localhost"
    { secureConnection: (port === 465),
      // XXX allow maxConnections to be configured?
      auth: auth,
      connectionTimeout: CLIENT_TIMEOUT,
      socketTimeout: CLIENT_TIMEOUT });

  pool._future_wrapped_sendMail = _.bind(Future.wrap(pool.sendMail), pool);
  return pool;
};

// We construct smtpPool at the first call to Email.send, so that
// Meteor.startup code can set $MAIL_URL.
var smtpPoolFuture = new Future();
var configured = false;

var getSmtpPool = function () {
  // We check MAIL_URL in case someone else set it in Meteor.startup code.
  if (!configured) {
    configured = true;
    var url = process.env.MAIL_URL;
    var pool = null;
    if (url)
      pool = makeSmtpPool(url);
    smtpPoolFuture.return(pool);
  }

  return smtpPoolFuture.wait();
};
