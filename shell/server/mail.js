var EmailMessage = Capnp.importSystem("sandstorm/email.capnp").EmailMessage;

var Fiber = Npm.require("fibers");

Meteor.startup(function() {
    simplesmtp.createSimpleServer({SMTPBanner:"My Server"}, function(req){
        var mailparser = new MailParser();
        var bufs = [];

        req.pipe(mailparser);
        mailparser.on('end', function(mail) {
            req.accept();
            console.log(mail);

            Fiber(function() {
                Grains.find().forEach(function(grain) { // TODO: only open sessions that this email should go to
                    Meteor.call('sendEmail', grain._id, {
                        date: (mail.date && mail.date.getTime()) || (new Date()).getTime(),
                        deliveredTo: {address: req.to}, // TODO: parse email
                        deliveredFrom: {address: req.from},
                        from: mail.from[0], // TODO: check that there's only 1 from field
                        to: mail.to,
                        cc: mail.cc || [],
                        bcc: mail.bcc || [],
                        replyTo: mail.headers['reply-to'] || [],
                        messageId: mail.headers['message-id'] || '',
                        references: mail.references || [],
                        inReplyTo: mail.inReplyTo || [],
                        subject: mail.subject || '',
                        bodyText: mail.text || '',
                        bodyHtml: mail.html || ''
                    });
                });
            }).run();
        });
    }).listen(30025);
});
