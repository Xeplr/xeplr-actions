// Shared on-disk helpers for the email actions that write files
// (email-download-email, email-download-attachments).
//
// Output goes to XEPLR_ACTIONS_TMP_DIR — the SAME directory db-fetch spools
// NDJSON into — so every artifact an action leaves behind is swept by one
// mechanism rather than one per action family. An explicit `outDir` input
// still wins for the case where a later step (or another service) needs the
// file somewhere specific.

var crypto = require('crypto');
var path   = require('path');
var fs     = require('fs');
var fsp    = require('fs/promises');
var os     = require('os');

// Short random prefix. Attachment names collide constantly in mail —
// "invoice.pdf" from fifty senders — and a download that silently overwrites
// the previous one is the kind of bug you find a quarter later in the numbers.
function shortId() {
  return crypto.randomBytes(5).toString('hex');
}

// Anything outside word/dot/dash becomes '_'. A filename arriving from a
// mailbox is attacker-controlled: without this, a name like
// "../../etc/cron.d/x" would escape the output directory entirely.
// Capped so a pathological name can't blow the filesystem's limit.
function sanitizeFilename(name) {
  var out = String(name || 'attachment').replace(/[^\w.\-]+/g, '_').slice(0, 180);
  // Stripping separators is not enough on its own: a name of "." or ".." has
  // none left and is STILL a traversal, because path.join(dir, '..') resolves
  // above dir. Any all-dots name gets replaced outright.
  if (/^\.+$/.test(out)) return 'attachment';
  return out;
}

// Explicit outDir wins; otherwise the same temp root the rest of the actions
// use. Created recursively — a first run has no directory yet.
async function resolveOutDir(outDir) {
  var dir = outDir || process.env.XEPLR_ACTIONS_TMP_DIR || path.join(os.tmpdir(), 'xeplr-actions');
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

// Filter predicate for attachment selection. Both filters optional; with
// neither, everything matches.
//   extension        — 'pdf' or '.pdf' (case-insensitive suffix)
//   filenameContains — case-insensitive substring
function attachmentMatches(name, extension, filenameContains) {
  var n = String(name || '').toLowerCase();
  if (extension) {
    var ext = String(extension).toLowerCase().replace(/^\./, '');
    if (n.slice(-(ext.length + 1)) !== '.' + ext) return false;
  }
  if (filenameContains && n.indexOf(String(filenameContains).toLowerCase()) === -1) {
    return false;
  }
  return true;
}

// On-disk name for a whole-message .eml. Prefers the subject — that is what a
// human recognises in a folder listing — and falls back to the uid when the
// message has none. Always prefixed, because "Re: Invoice" is not unique.
function emlFilename(subject, uid) {
  var base = sanitizeFilename(subject || ('message_' + uid)).replace(/\.eml$/i, '');
  return shortId() + '_' + base + '.eml';
}

module.exports = {
  shortId: shortId,
  sanitizeFilename: sanitizeFilename,
  resolveOutDir: resolveOutDir,
  attachmentMatches: attachmentMatches,
  emlFilename: emlFilename,
  fs: fs,
  path: path
};
