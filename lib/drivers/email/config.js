// WHERE AN EMAIL ACTION GETS ITS MAILBOX FROM.
//
// One checkbox: `useCustomConnection`.
//
//   OFF (default) — the mail service this install already runs. Every product
//                   here needs email for notifications anyway, so it is always
//                   configured; a step should not have to ask again.
//   ON            — a connection supplied on the step, for a workflow that
//                   talks to a mailbox the platform does not own (a client's,
//                   a shared alias).
//
// Off is the default deliberately. Requiring host/user/password on every step
// meant pasting credentials into a workflow document — visible to anyone who
// can open the builder, duplicated per step, and stale the day the mail server
// moves.

// ── inbound (IMAP) ──────────────────────────────────────────────────────

function num(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  var n = Number(v);
  return isFinite(n) ? n : fallback;
}

function bool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  var s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].indexOf(s) !== -1) return true;
  if (['0', 'false', 'no', 'off'].indexOf(s) !== -1) return false;
  return fallback;
}

/**
 * The install's IMAP mailbox, from env.
 *
 * IMAP_* wins, then SMTP_* — a mailbox is usually one account, and an install
 * that set SMTP credentials for sending has almost always given the same ones
 * for reading. Falling back beats making people set the same secret twice
 * under a second name.
 *
 * NOTE there is no "system IMAP service" the way there is a system MAIL
 * SENDER: @xeplr/email is outbound only. So for inbound, "system" means this
 * env block and nothing else.
 */
function imapFromEnv() {
  var env = process.env;
  var host = env.IMAP_HOST || env.SMTP_HOST;
  var user = env.IMAP_USER || env.SMTP_USER;
  var password = env.IMAP_PASS || env.SMTP_PASS;

  if (!host || !user || !password) {
    var missing = [];
    if (!host) missing.push('IMAP_HOST (or SMTP_HOST)');
    if (!user) missing.push('IMAP_USER (or SMTP_USER)');
    if (!password) missing.push('IMAP_PASS (or SMTP_PASS)');
    var err = new Error(
      'This install has no mailbox configured — missing ' + missing.join(', ') +
      '. Set those, or tick "Provide my own connection" on the step and supply one.'
    );
    err.code = 'EMAIL_SYSTEM_NOT_CONFIGURED';
    throw err;
  }

  var tls = {};
  if (env.IMAP_TLS_REJECT_UNAUTHORIZED !== undefined) tls.rejectUnauthorized = bool(env.IMAP_TLS_REJECT_UNAUTHORIZED, undefined);
  if (env.IMAP_TLS_SERVERNAME) tls.servername = env.IMAP_TLS_SERVERNAME;

  return {
    host: host,
    port: num(env.IMAP_PORT, 993),
    secure: bool(env.IMAP_SECURE, true),
    user: user,
    password: password,
    connectionTimeout: num(env.IMAP_CONNECTION_TIMEOUT, undefined),
    socketTimeout: num(env.IMAP_SOCKET_TIMEOUT, undefined),
    tls: Object.keys(tls).length ? tls : undefined
  };
}

/**
 * Resolve the inbound connection an action should use.
 *
 * @param {object} input  the action's own input (connectionSource, connection)
 */
function resolveInbound(input) {
  input = input || {};
  if (!input.useCustomConnection) return imapFromEnv();
  if (!input.connection || !input.connection.host) {
    throw new Error('"Provide my own connection" is on but no connection was supplied — set { host, user, password }, or turn it off to use this install\'s mailbox.');
  }
  return input.connection;
}

// ── outbound (send) ─────────────────────────────────────────────────────

/**
 * Whether this action should hand off to the install's own mail sender.
 *
 * Outbound "system" is NOT an env block the way inbound is — it is
 * @xeplr/utils' sendEmail, which is what @xeplr/email configures at startup
 * and which may be pointed at SES, Azure or Brevo rather than SMTP. Rebuilding
 * an SMTP connection out of env here would quietly ignore that and send
 * through the wrong provider, so the system path delegates instead.
 */
function usesSystemSender(input) {
  return !(input && input.useCustomConnection);
}

function resolveOutbound(input) {
  input = input || {};
  if (!input.connection || !input.connection.host) {
    throw new Error('"Provide my own connection" is on but no connection was supplied — set { host, user, password, from }, or turn it off to use this install\'s email service.');
  }
  return input.connection;
}

module.exports = {
  imapFromEnv: imapFromEnv,
  resolveInbound: resolveInbound,
  resolveOutbound: resolveOutbound,
  usesSystemSender: usesSystemSender
};
