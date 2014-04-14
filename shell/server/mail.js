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
                    Meteor.call('sendEmail', grain._id, mailMessage);
                });
            }).run();
        });
    }).listen(30025);
});
