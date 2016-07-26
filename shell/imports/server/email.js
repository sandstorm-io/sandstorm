import { Meteor } from "meteor/meteor";
import urlModule from "url";
import simplesmtp from "simplesmtp";
import { MailComposer } from "mailcomposer";

const Future = Npm.require("fibers/future");

const getSmtpConfig = function () {
  const config = Settings.findOne({ _id: "smtpConfig" });
  return config && config.value;
};

const makePool = function (mailConfig) {
  let auth = false;
  if (mailConfig.auth && (mailConfig.auth.user || mailConfig.auth.pass)) {
    auth = mailConfig.auth;
  }

  const pool = simplesmtp.createClientPool(
    mailConfig.port,
    mailConfig.hostname,
    { secureConnection: (mailConfig.port === 465),
      // XXX allow maxConnections to be configured?
      auth, });

  pool._futureWrappedSendMail = _.bind(Future.wrap(pool.sendMail), pool);
  return pool;
};

// We construct the SMTP pool at the first call to Email.send, so that
// other code like migrations can modify the SMTP configuration.
let pool;
let configured = false;

Meteor.startup(function () {
  Settings.find({ _id: "smtpConfig" }).observeChanges({
    removed: function () {
      configured = false;
    },

    changed: function () {
      configured = false;
    },

    added: function () {
      configured = false;
    },
  });
});

const getPool = function (smtpConfig) {
  if (smtpConfig) {
    return makePool(smtpConfig);
  } else if (!configured) {
    configured = true;
    const config = getSmtpConfig();
    if (config) {
      pool = makePool(config);
    }
  }

  return pool;
};

let nextDevmodeMailId = 0;
const outputStream = process.stdout;

const devModeSend = function (mc) {
  // This seems to be dead code.
  const devmodeMailId = nextDevmodeMailId++;

  const stream = outputStream;

  // This approach does not prevent other writers to stdout from interleaving.
  stream.write("====== BEGIN MAIL #" + devmodeMailId + " ======\n");
  stream.write("(Mail not sent; to enable sending, set the MAIL_URL " +
               "environment variable.)\n");
  mc.streamMessage();
  mc.pipe(stream, { end: false });
  const future = new Future;
  mc.on("end", function () {
    stream.write("====== END MAIL #" + devmodeMailId + " ======\n");
    future["return"]();
  });

  future.wait();
};

const smtpSend = function (pool, mc) {
  pool._futureWrappedSendMail(mc).wait();
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
const rawSend = function (mc, smtpConfig) {
  // SimpleSmtp does not add leading dots, so we need to.
  // See http://tools.ietf.org/html/rfc5321#section-4.5.2
  mc._message.body = mc._message.body.replace(/(^|\n)\./g, "$1..");

  const pool = getPool(smtpConfig);
  if (pool) {
    smtpSend(pool, mc);
  } else {
    throw new Error("SMTP pool is misconfigured.");
  }
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
 * @param {Object} [options.smtpConfig] SMTP server to use. Otherwise defaults to configured one.
 * @param {String} [options.smtpConfig.hostname] SMTP server hostname.
 * @param {Number} [options.smtpConfig.port] SMTP server port.
 * @param {Object} [options.smtpConfig.auth] SMTP server authentication tokens.  Optional.
 * @param {String} [options.smtpConfig.auth.user] Username of user to log in to SMTP server as.  Optional.
 * @param {String} [options.smtpConfig.auth.pass] Password of user to log in to SMTP server as.  Optional.
 * @param {Object} [options.attachments] Attachments. See:
 *   https://github.com/nodemailer/mailcomposer/tree/v0.1.15#add-attachments
 * @param {String} [options.envelopeFrom] Envelope sender.
 */
const send = function (options) {
  const mc = new MailComposer();

  // setup message data
  mc.setMessageOption({
    from: options.from,
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    replyTo: options.replyTo,
    subject: options.subject,
    text: options.text,
    html: options.html,
  });

  if (options.envelopeFrom) {
    const envelope = mc.getEnvelope();
    envelope.from = options.envelopeFrom;
    mc.setMessageOption({
      envelope: envelope,
    });
  }

  _.each(options.headers, function (value, name) {
    mc.addHeader(name, value);
  });

  _.each(options.attachments, function (value) {
    mc.addAttachment(value);
  });

  rawSend(mc, options.smtpConfig);
};

export { send, rawSend };
