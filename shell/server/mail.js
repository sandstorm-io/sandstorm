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
            req.accept();

            var deliverTo = req.to[0];
            var index = deliverTo.indexOf(' ');
            if(index != -1)
                deliverTo = deliverTo.slice(0, index);

            var mailMessage = {
                date: (mail.date && mail.date.getTime()) || (new Date()).getTime(),
                deliveredTo: {address: req.to}, // TODO: parse these properly
                deliveredFrom: {address: req.from},
                from: mail.from[0], // TODO: check that there's only 1 from field
                to: mail.to,
                cc: mail.cc || [],
                bcc: mail.bcc || [],
                replyTo: mail.headers['reply-to'] || {},
                messageId: mail.headers['message-id'] || Meteor.uuid(),
                references: mail.references || [],
                inReplyTo: mail.inReplyTo || [],
                subject: mail.subject || '',
                text: mail.text || '',
                html: mail.html || ''
            };

            Fiber(function() {
                Grains.find({email: deliverTo}).forEach(function(grain) {
                    Meteor.call('sendEmailToGrain', grain._id, mailMessage);
                });
            }).run();
        });
    }).listen(30025);
});

sendgrid = Sendgrid(Meteor.settings.SENDGRID_USERNAME, Meteor.settings.SENDGRID_PASSWORD);
this.sendEmail = function(email) {
    var sendGridEmail = {
      to:       email.to[0].address,
      // toname:   [],
      from:     email.from.address,
      // fromname: '',
      subject:  email.subject,
      text:     email.text,
      html:     email.html,
      // bcc:      [],
      // replyto:  '',
      // date:     new Date(),
      // headers:    {}
    };

    return new Promise(function(resolve, reject) {
        sendgrid.send(sendGridEmail, function(err, json) {
          if (err) { reject(err); }
          resolve();
        });
    });
};
