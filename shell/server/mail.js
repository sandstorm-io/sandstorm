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

Meteor.startup(function() {
    simplesmtp.createSimpleServer({SMTPBanner:"Sandstorm Mail Server"}, function(req){
        var mailparser = new MailParser();
        var bufs = [];

        req.pipe(mailparser);
        mailparser.on('end', function(mail) {
            var deliverTo = req.to[0];
            var index = deliverTo.indexOf('@');
            if(index == -1)
                console.error('Delivery address is invalid because it does not contain an @ symbol: ' + deliverTo);

            publicId = deliverTo.slice(0, index);
            // TODO: validate domain as well

            // TODO: check that mail's headers to/from match req.to/from

            var mailMessage = {
                date: (mail.date && mail.date.getTime()) || (new Date()).getTime(),
                from: mail.from[0], // TODO: check that there's only 1 from field
                to: mail.to,
                cc: mail.cc || [],
                bcc: mail.bcc || [],
                replyTo: mail.headers['reply-to'] || {},
                messageId: mail.headers['message-id'] || Meteor.uuid(), // TODO: append domain to conform to spec
                references: mail.references || [],
                inReplyTo: mail.inReplyTo || [],
                subject: mail.subject || '',
                text: mail.text || '',
                html: mail.html || ''
            };

            Fiber(function() {
                Grains.find({publicId: publicId}).forEach(function(grain) {
                    Meteor.call('sendEmailToGrain', grain._id, mailMessage);
                });
            }).run();

            req.accept();
        });
    }).listen(30025);
});
