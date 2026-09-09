// SMTP provider — the outbound half (email-send).
//
// `nodemailer` is an optional peer, lazy-required like the IMAP deps, so a
// deployment that only READS mail never has to install it.
//
// TRANSPORTS ARE NOT CACHED between calls. An action receives its connection
// as input and may legitimately be pointed at a different mailbox on the next
// run; a module-level cached transporter would silently keep sending through
// whichever one happened to be first. Reconnecting per send is the cost of
// that correctness, and SMTP connection setup is not the expensive part of
// sending mail.

var files = require('./files');

function loadNodemailer(action) {
  try {
    return require('nodemailer');
  } catch (_) {
    throw new Error(action + ": 'nodemailer' is not installed. Run `npm install nodemailer` to enable sending.");
  }
}

// nodemailer is only needed for the CUSTOM path — the system sender brings its
// own transport. Checking it unconditionally would demand an install that
// sends through SES also install an SMTP library it never uses.
function checkRequires(action, opts) {
  if (opts && opts.useSystem) return;
  loadNodemailer(action);
}

function compact(obj) {
  var out = {};
  Object.keys(obj || {}).forEach(function(k) {
    if (obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

// Flat `connection` input → nodemailer transport config, matching the shape
// the IMAP side takes so one connection object reads the same either way.
function buildTransportConfig(action, connection) {
  var c = connection || {};
  if (!c.host) throw new Error(action + ': connection requires { host } (and usually { user, password, from }).');

  var config = compact({
    host: c.host,
    port: c.port,
    // 465 is implicit SSL; 587/25 are STARTTLS. Derived from the port when
    // not stated, because the wrong pairing is the single most common way an
    // SMTP config fails — and it fails as a hang, not a message.
    secure: c.secure === undefined ? (Number(c.port) === 465) : c.secure,
    requireTLS: c.requireTLS,
    ignoreTLS: c.ignoreTLS,
    name: c.name,                       // EHLO/HELO hostname; some servers are picky
    connectionTimeout: c.connectionTimeout,
    greetingTimeout: c.greetingTimeout,
    socketTimeout: c.socketTimeout,
    pool: c.pool,
    maxConnections: c.maxConnections,
    maxMessages: c.maxMessages,
    authMethod: c.authMethod,
    logger: c.debug ? undefined : false,
    debug: c.debug
  });

  if (c.user || c.password) {
    config.auth = compact({ user: c.user, pass: c.password });
  }
  if (c.tls && Object.keys(c.tls).length > 0) {
    config.tls = c.tls;
  }

  // `options` — the escape hatch, mirroring SMTP_OPTIONS on the env side (see
  // @xeplr/utils smtpFromEnv). The named fields above cover the common ground;
  // this carries whatever one particular server needs that nothing here has a
  // name for. Merged LAST so it can override them, with `tls` merged a level
  // deeper rather than replaced.
  if (c.options && typeof c.options === 'object' && !Array.isArray(c.options)) {
    var extraTls = c.options.tls;
    Object.keys(c.options).forEach(function(k) {
      if (k !== 'tls') config[k] = c.options[k];
    });
    if (extraTls) config.tls = Object.assign({}, config.tls, extraTls);
  }

  return config;
}

/**
 * Send one message.
 *
 * Attachments accept nodemailer's own descriptors — `{ filename, path }`,
 * `{ filename, content }`, `{ filename, href }` — which means the output of
 * email-download-attachments (`saved[]`, each carrying `filename` + `path`)
 * can be handed straight back in to forward what was just downloaded.
 *
 * `envelopeFrom` sets the SMTP-level MAIL FROM / Return-Path separately from
 * the header From, which is what bounce handling keys on when the two differ.
 */
/**
 * Send through the INSTALL'S OWN configured sender (@xeplr/utils), which is
 * what @xeplr/email sets up at startup and may be SMTP, SES, Azure or Brevo.
 *
 * Deliberately delegates rather than rebuilding an SMTP transport from env: an
 * install configured for SES would otherwise be silently sent through SMTP
 * instead, which is the kind of bug that only shows up as "some mail never
 * arrived".
 *
 * That sender takes (to, subject, html, cc, attachments) and nothing else, so
 * the fields it cannot carry are REJECTED rather than dropped. Silently losing
 * a bcc is worse than refusing to send: one is a visible error at build time,
 * the other is a compliance question a year later.
 */
async function sendViaSystem(input) {
  var utils;
  try {
    utils = require('@xeplr/utils/lib/email');
  } catch (_) {
    throw new Error("email-send: this install's email service ('@xeplr/utils') is not installed. Install it, or tick \"Provide my own connection\" and supply an SMTP connection.");
  }

  var unsupported = ['text', 'bcc', 'from', 'replyTo'].filter(function(k) {
    return input[k] !== undefined && input[k] !== '' && !(Array.isArray(input[k]) && !input[k].length);
  });
  if (unsupported.length) {
    throw new Error(
      'email-send: the system sender does not support ' + unsupported.join(', ') +
      ' — it sends to/subject/html/cc/attachments only. Remove those, or tick "Provide my own connection" and send through your own SMTP connection.'
    );
  }
  if (!input.html) {
    throw new Error('email-send: the system sender requires `html` (it has no plain-text path). Tick "Provide my own connection" to send plain text.');
  }

  await utils.sendEmail(input.to, input.subject, input.html, input.cc, input.attachments);
  return {
    sent: true,
    via: 'system',
    // The system sender may QUEUE rather than send inline (see its own
    // sendEmail), so there is no messageId or per-recipient result to report.
    // Saying so beats inventing fields that would read as confirmation.
    messageId: null,
    accepted: [],
    rejected: [],
    response: 'handed to the system email service'
  };
}

/**
 * @param {object|null} connection  the step's own connection ('custom'), or
 *   null when sending through the install's configured sender ('system')
 * @param {object} input
 * @param {boolean} useSystem  send via @xeplr/utils rather than a transport
 *   built here. An explicit parameter rather than a flag smuggled through
 *   `input`, which would be indistinguishable from a real action input.
 */
async function send(connection, input, useSystem) {
  input = input || {};
  var c = connection || {};

  var to = input.to;
  if (typeof to === 'string') to = [to];
  if (!to || !to.length) throw new Error('email-send: at least one recipient in `to` is required.');
  if (!input.subject) throw new Error('email-send: subject is required.');
  if (!input.html && !input.text) throw new Error('email-send: one of `html` or `text` is required.');

  if (useSystem) {
    return sendViaSystem(Object.assign({}, input, { to: to }));
  }

  var nodemailer = loadNodemailer('email-send');
  var from = input.from || c.from;
  if (!from) throw new Error('email-send: `from` is required (pass input.from or connection.from).');

  var transporter = nodemailer.createTransport(buildTransportConfig('email-send', c));

  try {
    var mail = compact({
      from: from,
      to: to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo: input.replyTo || c.replyTo || from,
      attachments: input.attachments
    });

    if (c.envelopeFrom) {
      mail.envelope = { from: c.envelopeFrom, to: to };
    }

    var info = await transporter.sendMail(mail);
    return {
      sent: true,
      messageId: info.messageId || null,
      // Servers accept per-recipient: a 200 with everything in `rejected` is a
      // failed send that looks like a success unless both are surfaced.
      accepted: info.accepted || [],
      rejected: info.rejected || [],
      response: info.response || null
    };
  } finally {
    // Pooled transports hold sockets open and would keep the process alive.
    if (typeof transporter.close === 'function') transporter.close();
  }
}

module.exports = {
  checkRequires: checkRequires,
  send: send,
  files: files
};
