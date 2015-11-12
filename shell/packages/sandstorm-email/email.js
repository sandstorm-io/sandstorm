var Future = Npm.require('fibers/future');
var urlModule = Npm.require('url');
var MailComposer = Npm.require('mailcomposer').MailComposer;

SandstormEmail = {};

var getSmtpUrl = function () {
  var setting = Settings.findOne({_id: "smtpUrl"});
  if (setting) {
    return setting.value;
  } else {
    return process.env.MAIL_URL;
  }
};

var makePool = function (mailUrlString) {
  var mailUrl = urlModule.parse(mailUrlString);
  if (mailUrl.protocol !== 'smtp:')
    throw new Error("Email protocol in $MAIL_URL (" +
                    mailUrlString + ") must be 'smtp'");

  var port = +(mailUrl.port);
  var auth = false;
  if (mailUrl.auth) {
    var parts = mailUrl.auth.split(':', 2);
    auth = {user: parts[0],
            pass: parts[1]};
  }

  var simplesmtp = Npm.require('simplesmtp');
  var pool = simplesmtp.createClientPool(
    port,  // Defaults to 25
    mailUrl.hostname,  // Defaults to "localhost"
    { secureConnection: (port === 465),
      // XXX allow maxConnections to be configured?
      auth: auth });

  pool._future_wrapped_sendMail = _.bind(Future.wrap(pool.sendMail), pool);
  return pool;
};

// We construct smtpPool at the first call to Email.send, so that
// Meteor.startup code can set $MAIL_URL.
var pool;
var configured = false;

Meteor.startup(function() {
  Settings.find({_id: "smtpUrl"}).observeChanges({
    removed : function () {
      configured = false;
    },
    changed : function () {
      configured = false;
    },
    added : function () {
      configured = false;
    }
  });

  // Accounts.emailToken is set to use "Email" by default. Change it to use our mail service.
  Accounts.emailToken.setEmailPackage("SandstormEmail");
});

var getPool = function (smtpUrl) {
  if (smtpUrl) {
    return makePool(smtpUrl);
  } else if (!configured) {
    configured = true;
    var url = getSmtpUrl();
    if (url) {
      pool = makePool(url);
    }
  }

  return pool;
};

var next_devmode_mail_id = 0;
var output_stream = process.stdout;

var devModeSend = function (mc) {
  var devmode_mail_id = next_devmode_mail_id++;

  var stream = output_stream;

  // This approach does not prevent other writers to stdout from interleaving.
  stream.write("====== BEGIN MAIL #" + devmode_mail_id + " ======\n");
  stream.write("(Mail not sent; to enable sending, set the MAIL_URL " +
               "environment variable.)\n");
  mc.streamMessage();
  mc.pipe(stream, {end: false});
  var future = new Future;
  mc.on('end', function () {
    stream.write("====== END MAIL #" + devmode_mail_id + " ======\n");
    future['return']();
  });
  future.wait();
};

var smtpSend = function (pool, mc) {
  pool._future_wrapped_sendMail(mc).wait();
};

// Old comment below
/**
 * Send an email.
 *
 * Connects to the mail server configured via the MAIL_URL environment
 * variable. If unset, prints formatted message to stdout. The "from" option
 * is required, and at least one of "to", "cc", and "bcc" must be provided;
 * all other options are optional.
 *
 * @param options
 * @param options.from {String} RFC5322 "From:" address
 * @param options.to {String|String[]} RFC5322 "To:" address[es]
 * @param options.cc {String|String[]} RFC5322 "Cc:" address[es]
 * @param options.bcc {String|String[]} RFC5322 "Bcc:" address[es]
 * @param options.replyTo {String|String[]} RFC5322 "Reply-To:" address[es]
 * @param options.subject {String} RFC5322 "Subject:" line
 * @param options.text {String} RFC5322 mail body (plain text)
 * @param options.html {String} RFC5322 mail body (HTML)
 * @param options.headers {Object} custom RFC5322 headers (dictionary)
 */

// New API doc comment below
/**
 * @summary Send an email. Throws an `Error` on failure to contact mail server
 * or if mail server returns an error. All fields should match
 * [RFC5322](http://tools.ietf.org/html/rfc5322) specification.
 * @locus Server
 * @param {Object} options
 * @param {String} options.from "From:" address (required)
 * @param {String|String[]} options.to,cc,bcc,replyTo
 *   "To:", "Cc:", "Bcc:", and "Reply-To:" addresses
 * @param {String} [options.subject]  "Subject:" line
 * @param {String} [options.text|html] Mail body (in plain text or HTML)
 * @param {Object} [options.headers] Dictionary of custom headers
 * @param {String} [options.smtpUrl] SMTP server to use. Otherwise defaults to configured one.
 */
SandstormEmail.send = function (options) {
  var mc = new MailComposer();

  // setup message data
  // XXX support attachments (once we have a client/server-compatible binary
  //     Buffer class)
  mc.setMessageOption({
    from: options.from,
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    replyTo: options.replyTo,
    subject: options.subject,
    text: options.text,
    html: options.html
  });

  _.each(options.headers, function (value, name) {
    mc.addHeader(name, value);
  });

  SandstormEmail.rawSend(mc, options.smtpUrl);
};

/**
 * @summary Sends a raw email with a MailComposer object.
 * Throws an `Error` on failure to contact mail server
 * or if mail server returns an error. All fields should match
 * [RFC5322](http://tools.ietf.org/html/rfc5322) specification.
 * @locus Server
 * @param {Object} mc A MailCompser object that you wish to send
 * @param {String} smtpUrl SMTP server to use. If falsey, defaults to configured one.
*/
SandstormEmail.rawSend = function (mc, smtpUrl) {
  // SimpleSmtp does not add leading dots, so we need to.
  // See http://tools.ietf.org/html/rfc5321#section-4.5.2
  mc._message.body = mc._message.body.replace(/(^|\n)\./g, "$1..");

  var pool = getPool(smtpUrl);
  if (pool) {
    smtpSend(pool, mc);
  } else {
    throw new Error("SMTP pool is misconfigured.");
  }
};
