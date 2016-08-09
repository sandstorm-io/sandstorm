import { Meteor } from "meteor/meteor";
import nodemailer from "nodemailer";
import smtpPool from "nodemailer-smtp-pool";

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

  const pool = nodemailer.createTransport(smtpPool({
    host: mailConfig.hostname,
    port: mailConfig.port,
    secure: (mailConfig.port === 465),
    // XXX allow maxConnections to be configured?
    auth,
  }));

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

const smtpSend = function (pool, mailOptions) {
  pool._futureWrappedSendMail(mailOptions).wait();
};

const rawSend = function (mailOptions, smtpConfig) {
  // Sends an email mailOptions object structured as described in
  // https://github.com/nodemailer/mailcomposer#e-mail-message-fields
  // across the transport described by smtpConfig.
  const pool = getPool(smtpConfig);
  if (pool) {
    smtpSend(pool, mailOptions);
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
  // Unpack options
  const {
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject,
    text,
    html,
    envelopeFrom,
    headers,
    attachments,
    smtpConfig,
  } = options;

  const opts = {
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject,
    text,
    html,
    headers,
    attachments,
  };

  if (envelopeFrom) {
    opts.envelope = {
      from: envelopeFrom,
      to,
      cc,
      bcc,
    };
  }

  rawSend(opts, smtpConfig);
};

export { send, rawSend };

// TODO(cleanup): Remove this once BlackrockPayments code finds a better way to import it.
global.SandstormEmail = { send };
