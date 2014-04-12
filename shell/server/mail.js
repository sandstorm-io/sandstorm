var EmailMessage = Capnp.importSystem("sandstorm/email.capnp").EmailMessage;

var Fiber = Npm.require("fibers");

Meteor.startup(function() {
    simplesmtp.createSimpleServer({SMTPBanner:"My Server"}, function(req){
        var bufs = [];
        req.on('data', function(chunk) {
            bufs.push(chunk); // TODO: protect against overly large messages
        });
        req.on('end', function() {
            var buf = Buffer.concat(bufs);
            req.accept();

            Fiber(function() {
                Grains.find().forEach(function(grain) { // TODO: only open sessions that this email should go to
                    Meteor.call('sendEmail', grain._id, {
                        to: req.to,
                        from: req.from,
                        bodyText: buf.toString()
                    });
                });
            }).run();
        });
    }).listen(30025);
});
