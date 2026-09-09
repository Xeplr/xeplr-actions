// IMAP provider — the inbound half of the email actions (read, move, delete,
// download_email, download_attachments).
//
// PEER DEPS ARE LAZY. `imapflow` and `mailparser` are optional peers and are
// required INSIDE the call that needs them, never at module load, so a
// deployment that only sends mail never has to install them and importing the
// builtins index doesn't throw. checkRequires() below is what turns a missing
// one into a clear message instead of MODULE_NOT_FOUND.
//
// CONNECTION LIFECYCLE mirrors the db drivers: connect → use → close, one
// connection per action call, released in a `finally`. An action that touches
// several messages (read pulling 50, download pulling all attachments of one)
// does all of it on that single connection rather than reconnecting per
// message.
//
// A NOTE ON `uid`. Every operation here addresses a message by IMAP UID, which
// is scoped to (folder, UIDVALIDITY) — it is NOT a global message id, and a
// message's UID CHANGES when it moves folders. Hence `folder` on every action:
// the uid alone is not an address. Sequence a workflow so any move is the last
// step on a message, or re-read after moving.

var files = require('./files');

// ─── peer deps ──────────────────────────────────────────────────────────

function loadImapFlow(action) {
  try {
    return require('imapflow').ImapFlow;
  } catch (_) {
    throw new Error(action + ": 'imapflow' is not installed. Run `npm install imapflow` to enable IMAP support.");
  }
}

function loadMailParser(action) {
  try {
    return require('mailparser').simpleParser;
  } catch (_) {
    throw new Error(action + ": 'mailparser' is not installed. Run `npm install mailparser` to enable message parsing.");
  }
}

// Called by each action before it connects, so a missing peer dep fails with
// the install line rather than at some arbitrary point mid-run.
function checkRequires(action, opts) {
  loadImapFlow(action);
  if (opts && opts.needsParser) loadMailParser(action);
}

// ─── config ─────────────────────────────────────────────────────────────

// Drop undefined keys so we never overwrite an imapflow default with
// `undefined` by spreading.
function compact(obj) {
  var out = {};
  Object.keys(obj || {}).forEach(function(k) {
    if (obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

// Flat `connection` input → imapflow client config. Flat on purpose: it is the
// same shape db-fetch takes ({ host, port, user, password, ... }), so a
// connection reads the same across every action in this package.
//
// Host/user/password are hard requirements — IMAP cannot be attempted blind,
// and a half-specified transport fails as an opaque timeout rather than a
// useful error.
function buildClientConfig(action, connection) {
  var c = connection || {};
  if (!c.host || !c.user || !c.password) {
    throw new Error(action + ': connection requires { host, user, password } (port/secure default to 993/true).');
  }
  return compact({
    host: c.host,
    // 993 is implicit TLS, 143 is STARTTLS. Defaulting to the secure pair
    // rather than the plaintext one — an unencrypted mailbox login should be
    // something you opt into, not something you get by omission.
    port: c.port === undefined ? 993 : c.port,
    secure: c.secure === undefined ? true : c.secure,
    auth: { user: c.user, pass: c.password },
    connectionTimeout: c.connectionTimeout,
    greetTimeout: c.greetTimeout,
    socketTimeout: c.socketTimeout,
    tls: (c.tls && Object.keys(c.tls).length > 0) ? c.tls : undefined,
    // imapflow's own logger writes a line per protocol command at info level.
    // The actions return structured results; the protocol chatter belongs off
    // by default and behind an explicit flag.
    logger: c.debug ? undefined : false
  });
}

// ─── connection helper ──────────────────────────────────────────────────

// connect → open mailbox → run → release lock → logout. Every inbound op goes
// through this so the release/logout pair can never be forgotten in one of
// them. `logout()` is best-effort in its own catch: a failure there must not
// mask the real error from the work, and must not fail an op that succeeded.
async function withMailbox(action, connection, folder, fn) {
  // Config FIRST, deps second. Validating the connection needs no peer dep, so
  // a misconfigured connection reports the missing field even on a host that
  // hasn't installed imapflow — otherwise the dep error masks the real one.
  var config = buildClientConfig(action, connection);
  var ImapFlow = loadImapFlow(action);
  var client = new ImapFlow(config);

  await client.connect();
  try {
    var lock = await client.getMailboxLock(folder || 'INBOX');
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch (_) { /* connection already gone */ }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────

// imapflow takes an object of IMAP SEARCH keys. Note that IMAP's FROM and
// SUBJECT are SUBSTRING matches by specification — there is no exact-match
// key — so `from_equals` is sent as a substring narrowing here and then
// enforced exactly on the client side in read(). Sending it still pays: it
// keeps the server from returning the whole mailbox.
function buildSearch(input) {
  var criteria = {};
  if (input.unread_only) criteria.seen = false;
  if (input.since) criteria.since = new Date(input.since);
  if (input.from_contains || input.from_equals) criteria.from = input.from_contains || input.from_equals;
  if (input.subject_contains) criteria.subject = input.subject_contains;
  // An empty object matches nothing on some servers; ALL is the explicit
  // "everything in this mailbox".
  if (Object.keys(criteria).length === 0) criteria.all = true;
  return criteria;
}

// Post-filters that IMAP cannot express. from_equals is the real one — the
// server can only narrow to a substring, so "a@b.com" would otherwise also
// match "not-a@b.com".
function passesClientFilters(input, from_addr, subject) {
  var s = String(subject || '').toLowerCase();
  var f = String(from_addr || '').toLowerCase();
  if (input.subject_contains && s.indexOf(String(input.subject_contains).toLowerCase()) === -1) return false;
  if (input.from_equals && f !== String(input.from_equals).toLowerCase()) return false;
  if (input.from_contains && f.indexOf(String(input.from_contains).toLowerCase()) === -1) return false;
  return true;
}

// Walk a BODYSTRUCTURE for a part that is dispositioned as an attachment.
// Used on the metadata-only path, where the message source is never
// downloaded and mailparser therefore cannot tell us this.
function structureHasAttachment(node) {
  if (!node) return false;
  if (String(node.disposition || '').toLowerCase() === 'attachment') return true;
  var kids = node.childNodes || node.children || [];
  for (var i = 0; i < kids.length; i++) {
    if (structureHasAttachment(kids[i])) return true;
  }
  return false;
}

function addressList(list) {
  return (list || []).map(function(a) { return a.address; }).filter(Boolean);
}

// ─── operations ─────────────────────────────────────────────────────────

/**
 * Read messages from a mailbox, newest first.
 *
 * TWO PATHS, chosen by `body`:
 *   'none' → ENVELOPE + FLAGS + BODYSTRUCTURE fetch only. Nothing is
 *            downloaded or parsed, which is what makes a monitor that just
 *            wants ids/subjects cheap enough to run on a schedule.
 *   else   → full source download + mailparser, because bodies (and a
 *            reliable attachment flag) genuinely require the message.
 *
 * The split matters: downloading every matched message purely to read its
 * subject means fetching megabytes of inline base64 to keep a 40-byte field.
 */
async function read(connection, input) {
  input = input || {};
  var folder = input.folder || 'INBOX';
  var body = input.body || 'full';
  var wantHtml = body === 'full';
  var wantText = body === 'full' || body === 'text';
  var wantBodies = body !== 'none';

  // Validate the connection before loading the parser, for the same reason
  // withMailbox does: a bad connection should say which field is missing
  // rather than report a peer dep that is only needed once it works.
  buildClientConfig('email-read', connection);
  var simpleParser = wantBodies ? loadMailParser('email-read') : null;

  return withMailbox('email-read', connection, folder, async function(client) {
    var uids = (await client.search(buildSearch(input), { uid: true })) || [];

    // Cap defensively — `limit` reaches this from a workflow input, and an
    // unbounded mailbox read is how a step OOMs the runner.
    var cap = Math.min(Math.max(Number(input.limit) || 50, 1), 1000);
    var slice = uids.slice(-cap).reverse();   // newest first
    if (slice.length === 0) return [];

    var out = [];

    if (!wantBodies) {
      var fetchOpts = { uid: true, envelope: true, flags: true, bodyStructure: true };
      for await (var msg of client.fetch(slice, fetchOpts, { uid: true })) {
        var env = msg.envelope || {};
        var fromAddr = (env.from && env.from[0] && env.from[0].address) || '';
        if (!passesClientFilters(input, fromAddr, env.subject)) continue;
        out.push({
          id: String(msg.uid),
          uid: msg.uid,
          subject: env.subject || '',
          from: fromAddr,
          from_name: (env.from && env.from[0] && env.from[0].name) || null,
          to: addressList(env.to),
          cc: addressList(env.cc),
          received_at: env.date ? new Date(env.date).toISOString() : null,
          has_attachments: structureHasAttachment(msg.bodyStructure),
          body_html: null,
          body_text: null,
          // The real flag, not a hardcoded false — `\Seen` is what "read"
          // means, and a monitor that re-processes already-handled mail
          // because this lied is a costly kind of wrong.
          is_read: !!(msg.flags && msg.flags.has && msg.flags.has('\\Seen')),
          message_id: env.messageId || null,
          folder: folder
        });
      }
      return out;
    }

    for (var i = 0; i < slice.length; i++) {
      var uid = slice[i];
      var dl = await client.download(uid, undefined, { uid: true });
      var parsed = await simpleParser(dl.content);
      var addr = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '';
      if (!passesClientFilters(input, addr, parsed.subject)) continue;
      out.push({
        id: String(uid),
        uid: uid,
        subject: parsed.subject || '',
        from: addr,
        from_name: (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].name) || null,
        to: addressList(parsed.to && parsed.to.value),
        cc: addressList(parsed.cc && parsed.cc.value),
        received_at: parsed.date ? parsed.date.toISOString() : null,
        has_attachments: Array.isArray(parsed.attachments) && parsed.attachments.length > 0,
        body_html: wantHtml ? (parsed.html || null) : null,
        body_text: wantText ? (parsed.text || null) : null,
        is_read: null,   // not fetched on this path; use body:'none' for flags
        message_id: parsed.messageId || null,
        folder: folder
      });
    }
    return out;
  });
}

/** Move one message to another folder. Returns the shape the action wraps. */
async function move(connection, input) {
  input = input || {};
  if (!input.messageId) throw new Error('email-move: messageId is required.');
  if (!input.toFolder) throw new Error('email-move: toFolder is required.');

  return withMailbox('email-move', connection, input.folder || 'INBOX', async function(client) {
    await client.messageMove(String(input.messageId), input.toFolder, { uid: true });
    return {
      moved: true,
      messageId: String(input.messageId),
      fromFolder: input.folder || 'INBOX',
      toFolder: input.toFolder
    };
  });
}

/**
 * Delete one message.
 *
 * PERMANENT. imapflow's messageDelete flags \Deleted and EXPUNGES, so this is
 * not a move to Trash and there is nothing to undo. Moving to the server's
 * trash folder is `email-move`, and is what you usually want.
 */
async function remove(connection, input) {
  input = input || {};
  if (!input.messageId) throw new Error('email-delete: messageId is required.');

  return withMailbox('email-delete', connection, input.folder || 'INBOX', async function(client) {
    await client.messageDelete(String(input.messageId), { uid: true });
    return { deleted: true, messageId: String(input.messageId), folder: input.folder || 'INBOX' };
  });
}

/**
 * Save the whole message as an RFC-822 .eml.
 *
 * Streamed straight to disk, never parsed and never buffered whole: IMAP's raw
 * source IS the .eml format, so there is nothing to build, and a message
 * carrying a 40 MB attachment must not become a 40 MB string first.
 *
 * The subject comes from a separate ENVELOPE fetch — cheap metadata, not a
 * body download — purely so the file has a name a human recognises.
 */
async function downloadEmail(connection, input) {
  input = input || {};
  if (!input.messageId) throw new Error('email-download-email: messageId is required.');
  var pipeline = require('stream/promises').pipeline;
  var uid = String(input.messageId);

  return withMailbox('email-download-email', connection, input.folder || 'INBOX', async function(client) {
    var subject = null;
    try {
      var meta = await client.fetchOne(uid, { envelope: true }, { uid: true });
      subject = (meta && meta.envelope && meta.envelope.subject) || null;
    } catch (_) { /* filename falls back to the uid — never fatal */ }

    var dl = await client.download(uid, undefined, { uid: true });

    var dir = await files.resolveOutDir(input.outDir);
    var filename = files.emlFilename(subject, uid);
    var filepath = files.path.join(dir, filename);

    await pipeline(dl.content, files.fs.createWriteStream(filepath));

    var size = files.fs.statSync(filepath).size;
    return {
      count: 1,
      // Same shape as download-attachments, so a downstream step binds to
      // `path` / `saved[]` identically whichever produced the file.
      saved: [{ filename: filename, path: filepath, size: size, contentType: 'message/rfc822' }],
      path: filepath,
      subject: subject,
      messageId: uid
    };
  });
}

/**
 * Save a message's attachments to disk, optionally filtered.
 *
 * Unlike downloadEmail this MUST parse — attachments are MIME parts, and
 * extracting one means decoding the message. Writes are streamed per part.
 */
async function downloadAttachments(connection, input) {
  input = input || {};
  if (!input.messageId) throw new Error('email-download-attachments: messageId is required.');
  var simpleParser = loadMailParser('email-download-attachments');
  var uid = String(input.messageId);

  return withMailbox('email-download-attachments', connection, input.folder || 'INBOX', async function(client) {
    var dl = await client.download(uid, undefined, { uid: true });
    var parsed = await simpleParser(dl.content);
    var all = parsed.attachments || [];

    var dir = await files.resolveOutDir(input.outDir);
    var saved = [];
    var skipped = 0;

    for (var i = 0; i < all.length; i++) {
      var a = all[i];
      if (!files.attachmentMatches(a.filename, input.extension, input.filenameContains)) { skipped++; continue; }
      var filename = files.shortId() + '_' + files.sanitizeFilename(a.filename);
      var filepath = files.path.join(dir, filename);
      files.fs.writeFileSync(filepath, a.content);
      saved.push({
        filename: a.filename || filename,
        path: filepath,
        size: a.size || (a.content && a.content.length) || null,
        contentType: a.contentType || null
      });
    }

    return {
      count: saved.length,
      saved: saved,
      path: saved.length ? saved[0].path : null,
      // Reported rather than silent: "0 attachments" and "6 attachments, none
      // matched your filter" are different problems with the same count.
      skipped: skipped,
      messageId: uid
    };
  });
}

module.exports = {
  checkRequires: checkRequires,
  read: read,
  move: move,
  delete: remove,
  downloadEmail: downloadEmail,
  downloadAttachments: downloadAttachments
};
