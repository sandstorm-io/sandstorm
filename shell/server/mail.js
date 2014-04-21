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

var EmailMessage = Capnp.importSystem("sandstorm/email.capnp").EmailMessage;

var Fiber = Npm.require("fibers");
var Url = Npm.require('url');

Meteor.startup(function() {
  this.HOSTNAME = Url.parse(process.env.ROOT_URL).hostname;
  var SANDSTORM_SMTP_PORT = parseInt(process.env.SANDSTORM_SMTP_PORT, 10) || 30025;

  simplesmtp.createSimpleServer({SMTPBanner:"Sandstorm Mail Server"}, function(req){
    var mailparser = new MailParser();
    var bufs = [];

    req.pipe(mailparser);
    mailparser.on('end', function(mail) {
      req.to.forEach(function(deliverTo) {
        var parsedTo = mimelib.parseAddresses(deliverTo)[0].address;
        var parsedFrom = mimelib.parseAddresses(req.from)[0].address;
        var index = parsedTo.indexOf('@');
        // simplesmtp checks addresses for us, so no need to worry that @ isn't in the address

        publicId = parsedTo.slice(0, index);
        domain = parsedTo.slice(index+1);

        if(domain !== HOSTNAME) {
          message = "Received message with a To field of an unknown domain: " +
            deliverTo + " instead of " + HOSTNAME;

          console.error(message);
          req.reject(message);
          return;
        }

        if(mail.from.length != 1)
          console.warn("More or less than 1 `from` address seen in message's headers. Ignoring for now");

        // TODO: warn the user in some way that the received message had wrong headers
        // TODO: check the same for To/CC/BCC
        if(parsedFrom !== mail.from[0].address) {
          console.warn("From address was different between smtp and message's headers: " + parsedFrom + ' vs ' + mail.from[0].address);
          mail.from[0].address = parsedFrom;
        }

        var mailMessage = {
            date: (mail.date && mail.date.getTime()) || (new Date()).getTime(),
            from: mail.from[0],
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

        Fiber(function() {
          var grains = Grains.find({publicId: publicId}).fetch();

          if(grains.length < 1) {
            message = "No grains found with the given publicId: " + publicId;

            console.error(message);
            req.reject(message);
            return;
          }

          grains.forEach(function(grain) {
              Meteor.call('sendEmailToGrain', grain._id, mailMessage);
          });

          req.accept();
        }).run();
      });
    });
  }).listen(SANDSTORM_SMTP_PORT);
});
