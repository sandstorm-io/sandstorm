var EmailMessage = Capnp.importSystem("sandstorm/email.capnp").EmailMessage;

Meteor.startup(function() {
    simplesmtp.createSimpleServer({SMTPBanner:"My Server"}, function(req){
        var bufs = [];
        req.on('data', function(chunk) {
            bufs.push(chunk); // TODO: protect against overly large messages
        });
        req.on('end', function() {
            var buf = Buffer.concat(bufs);
            req.accept();
            Capnp.serialize(EmailMessage, {
                to: req.to,
                from: req.from,
                bodyText: buf.toString()
            });
        });
    }).listen(30025);
});
