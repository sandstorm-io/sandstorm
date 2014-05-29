// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// This file is part of the Sandstorm platform implementation.
//
// Sandstorm is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Sandstorm is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public
// License along with Sandstorm.  If not, see
// <http://www.gnu.org/licenses/>.

var EmailRpc = Capnp.importSystem("sandstorm/email.capnp");
var HackSessionContext = Capnp.importSystem("sandstorm/hack-session.capnp").HackSessionContext;
var EmailMessage = EmailRpc.EmailMessage;
var EmailSendPort = EmailRpc.EmailSendPort;

var Url = Npm.require("url");

var HOSTNAME = Url.parse(process.env.ROOT_URL).hostname;

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

        var mailMessage = {
          date: (mail.date || new Date()).toString(),
          from: from,
          to: mail.to,
          cc: mail.cc || [],
          bcc: mail.bcc || [],
          replyTo: mail.headers['reply-to'] || {},
          messageId: mail.headers['message-id'] || Meteor.uuid() + '@' + HOSTNAME,
          references: mail.references || [],
          inReplyTo: mail.inReplyTo || [],
          subject: mail.subject || '',
          text: mail.text || '',
          html: mail.html || ''
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
        return Promise.all(grainPublicIds.forEach(function (publicId) {
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
                throw new Error("No such grain: ", publicId);
              }
            }).then(function (connection) {
              var supervisor = this.connection.restore(null, Supervisor);
              var uiView = supervisor.getMainView().view;
              // Create a new session of type HackEmailSession. This is a short-term hack until
              // persistent capabilities and the Powerbox are implemented. A session of type
              // HackEmailSession expects a HackSessionContext and the session context and does not
              // take any session parameters.
              var session = uiView
                  .newSession({}, makeHackSessionContext(grainId), "0xc3b5ced7344b04a6", null)
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
  if (!field)
    return null;

  if (Array.isArray(field))
    return field.forEach(formatAddress);

  if (field.name)
    return field.name + ' <' + field.address + '>';

  return field.address;
};

function HackSessionContextImpl(grainId) {
  this.grainId = grainId;
}

makeHackSessionContext = function (grainId) {
  return new Capnp.Capability(new HackSessionContextImpl(grainId), HackSessionContext);
}

HackSessionContextImpl.prototype._getPublicId = function () {
  // Get the grain's public ID, assigning a new one if it doesn't yet have one.
  //
  // Must be called in a Meteor context.

  while (!this.publicId) {
    // We haven't looked up the public ID yet.
    var grain = Grains.findOne(this.grainId, {fields: {publicId: 1}});
    if (!grain) throw new Error("Grain does not exist.");

    if (grain.publicId) {
      this.publicId = grain.publicId;
    } else {
      // The grain doesn't have a public ID yet. Generate one.
      var candidate = Random.id();

      // Carefully perform an update that becomes a no-op if anyone else has assigned a public ID
      // simultaneously.
      if (Grains.update({_id: this.grainId, publicId: { $exists: false }},
                        { publicId: candidate }) > 0) {
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

HackSessionContextImpl.prototype.send = function (email) {
  return inMeteor(function() {
    // Overwrite the "from" address with the grain's address.
    if (!email.from) {
      email.from = {};
    }
    email.from.address = this._getAddress();

    var newEmail = {
      from:     formatAddress(email.from),
      to:       formatAddress(email.to),
      cc:       formatAddress(email.cc),
      bcc:      formatAddress(email.bcc),
      replyTo:  formatAddress(email.replyTo),
      subject:  email.subject,
      text:     email.text,
      html:     email.html
    };

    var headers = {};
    if(email.messageId)
      headers['message-id'] = email.messageId;
    if(email.references)
      headers['references'] = email.references;
    if(email.messageId)
      headers['in-reply-to'] = email.inReplyTo;
    // TODO(someday): parse and set date
    // if(email.date)
    //   headers['date'] = email.date;

    newEmail['headers'] = headers;

    Email.send(newEmail);
  });
};

HackSessionContextImpl.prototype.getAddress = function() {
  return inMeteor(function () {
    return this._getAddress();
  });
};
