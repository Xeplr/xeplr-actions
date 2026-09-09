// Email actions — everything verifiable without a live mailbox: the on-disk
// helpers (which are security-relevant), action registration, and the failure
// paths a workflow actually hits when misconfigured.
//
// The IMAP/SMTP round-trips themselves need a server and belong in a .live.js
// alongside db-move.live.js.
//
// Run:  node --test test/builtins/email.test.js

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');

var actions = require('../../index');
var files   = require('../../lib/drivers/email/files');
var drivers = require('../../lib/drivers/email');

var CONN = { host: 'mail.example.com', user: 'u@example.com', password: 'secret' };

// ─── filename safety ────────────────────────────────────────────────────

test('sanitizeFilename strips path separators so an attachment cannot escape outDir', function() {
  // The name comes from a mailbox, i.e. from whoever sent the mail.
  // The property that matters is containment, not the absence of any
  // particular character: dots are legal in a filename, separators are not.
  ['../../etc/cron.d/payload', '..', '.', '....', '/etc/passwd', 'a/../../b'].forEach(function(evil) {
    var safe = files.sanitizeFilename(evil);
    assert.ok(safe.indexOf('/') === -1, 'no separators survive: ' + safe);
    assert.strictEqual(
      path.dirname(path.join('/tmp/out', safe)), '/tmp/out',
      '"' + evil + '" → "' + safe + '" must stay inside the output directory'
    );
  });
});

test('sanitizeFilename caps length and survives empty/undefined', function() {
  assert.ok(files.sanitizeFilename('a'.repeat(500)).length <= 180);
  assert.strictEqual(files.sanitizeFilename(''), 'attachment');
  assert.strictEqual(files.sanitizeFilename(undefined), 'attachment');
});

test('emlFilename prefers the subject, falls back to the uid, always ends .eml', function() {
  var withSubject = files.emlFilename('Invoice #42', '99');
  assert.ok(/Invoice_42\.eml$/.test(withSubject), withSubject);

  var noSubject = files.emlFilename(null, '99');
  assert.ok(/message_99\.eml$/.test(noSubject), noSubject);

  // A subject that already ends in .eml must not produce "x.eml.eml".
  assert.ok(/report\.eml$/.test(files.emlFilename('report.eml', '1')));
});

test('emlFilename prefixes uniquely — "Re: Invoice" collides constantly', function() {
  var a = files.emlFilename('Re: Invoice', '1');
  var b = files.emlFilename('Re: Invoice', '1');
  assert.notStrictEqual(a, b, 'same subject must not produce the same filename');
});

// ─── attachment filtering ───────────────────────────────────────────────

test('attachmentMatches: no filters matches everything', function() {
  assert.strictEqual(files.attachmentMatches('anything.bin'), true);
});

test('attachmentMatches: extension works with and without the dot, case-insensitively', function() {
  assert.strictEqual(files.attachmentMatches('Report.PDF', 'pdf'), true);
  assert.strictEqual(files.attachmentMatches('Report.PDF', '.pdf'), true);
  assert.strictEqual(files.attachmentMatches('report.pdf', 'PDF'), true);
  assert.strictEqual(files.attachmentMatches('report.csv', 'pdf'), false);
});

test('attachmentMatches: extension is a real suffix, not a substring', function() {
  // "notes.pdf.zip" is a zip. Matching it for 'pdf' would hand a downstream
  // PDF step a zip file.
  assert.strictEqual(files.attachmentMatches('notes.pdf.zip', 'pdf'), false);
  // And a name that merely contains the letters must not match either.
  assert.strictEqual(files.attachmentMatches('pdfnotes.txt', 'pdf'), false);
});

test('attachmentMatches: filenameContains is a case-insensitive substring', function() {
  assert.strictEqual(files.attachmentMatches('Q3-Invoice-final.pdf', null, 'invoice'), true);
  assert.strictEqual(files.attachmentMatches('Q3-Receipt.pdf', null, 'invoice'), false);
});

test('attachmentMatches: both filters must pass', function() {
  assert.strictEqual(files.attachmentMatches('invoice.pdf', 'pdf', 'invoice'), true);
  assert.strictEqual(files.attachmentMatches('invoice.csv', 'pdf', 'invoice'), false);
  assert.strictEqual(files.attachmentMatches('receipt.pdf', 'pdf', 'invoice'), false);
});

// ─── provider registry ──────────────────────────────────────────────────

test('provider registry resolves defaults and names the supported set on a miss', function() {
  assert.ok(drivers.getInboundProvider(undefined), 'inbound defaults to imap');
  assert.ok(drivers.getInboundProvider('IMAP'), 'provider name is case-insensitive');
  assert.ok(drivers.getOutboundProvider(undefined), 'outbound defaults to smtp');

  assert.throws(
    function() { drivers.getInboundProvider('pop3'); },
    /unknown inbound provider "pop3".*supported: imap/,
    'a bad provider must say what IS supported'
  );
});

// ─── registration + failure paths ───────────────────────────────────────

var ALL = [
  ['email-read',                 require('../../lib/builtins/email/read')],
  ['email-move',                 require('../../lib/builtins/email/move')],
  ['email-delete',               require('../../lib/builtins/email/delete')],
  ['email-download-email',       require('../../lib/builtins/email/download-email')],
  ['email-download-attachments', require('../../lib/builtins/email/download-attachments')],
  ['email-send',                 require('../../lib/builtins/send-email')]
];

test('all six actions register and expose the name the workflow binds to', function() {
  ALL.forEach(function(pair) {
    actions.register(pair[1]);
    assert.strictEqual(pair[1].name, pair[0]);
    assert.ok(Array.isArray(pair[1].inputSchema) && pair[1].inputSchema.length > 0, pair[0] + ' has inputs');
    assert.strictEqual(typeof pair[1].execute, 'function', pair[0] + ' is executable');
  });
  ALL.forEach(function(pair) { assert.ok(actions.has(pair[0]), pair[0] + ' is registered'); });
});

test('every message-addressed action takes a folder — the id is folder-scoped', function() {
  ['email-move', 'email-delete', 'email-download-email', 'email-download-attachments'].forEach(function(name) {
    var def = actions.get(name);
    var folder = def.inputSchema.filter(function(f) { return f.name === 'folder'; })[0];
    assert.ok(folder, name + ' must accept a source folder');
    assert.strictEqual(folder.default, 'INBOX');
  });
});

test('missing required inputs fail with the field named, before any connection is attempted', async function() {
  var r = await actions.runAction({ name: 'email-move', input: { connection: CONN } });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.error.message, /messageId/);
  assert.match(r.error.message, /toFolder/);
});

test('omitting the connection is FINE — it means "use the system mailbox"', async function() {
  // This used to assert that a missing connection was a schema error. It is
  // not one any more, and the distinction matters: the action must get as far
  // as resolving a mailbox rather than refusing at the door. With the system
  // mailbox configured it proceeds; without it, it says so specifically.
  var host = process.env.IMAP_HOST, shost = process.env.SMTP_HOST;
  process.env.IMAP_HOST = 'mail.example.com';
  process.env.IMAP_USER = 'u'; process.env.IMAP_PASS = 'p';
  try {
    var r = await actions.runAction({ name: 'email-delete', input: { messageId: '1' } });
    assert.strictEqual(r.status, 'failed');
    // Past config resolution — the only thing left is the optional peer dep.
    assert.match(r.error.message, /imapflow/);
    assert.doesNotMatch(r.error.message, /no mailbox configured/);
  } finally {
    if (host) process.env.IMAP_HOST = host; else delete process.env.IMAP_HOST;
    if (shost) process.env.SMTP_HOST = shost;
    delete process.env.IMAP_USER; delete process.env.IMAP_PASS;
  }
});

test('a half-specified connection is rejected rather than hanging on connect', function() {
  var imap = require('../../lib/drivers/email/imap');
  // No password. Left to imapflow this surfaces much later as an auth failure
  // or a timeout; the point of the guard is to say which field is missing.
  return imap.read({ host: 'h', user: 'u' }, {}).then(
    function() { assert.fail('should have thrown'); },
    function(err) { assert.match(err.message, /host, user, password/); }
  );
});

// ─── choosing the mailbox ───────────────────────────────────────────────
// The default has to be "use what this install already has". Requiring a
// connection on every step meant pasting credentials into a workflow
// document — per step, visible to anyone who can open the builder, and stale
// the day the mail server moves.

test('the connection is one OFF-by-default checkbox, and hidden until ticked', function() {
  ALL.forEach(function(pair) {
    var def = pair[1];
    var conn = def.inputSchema.filter(function(f) { return f.name === 'connection'; })[0];
    var toggle = def.inputSchema.filter(function(f) { return f.name === 'useCustomConnection'; })[0];

    assert.ok(toggle, pair[0] + ' offers the toggle');
    assert.strictEqual(toggle.type, 'boolean', pair[0] + ': it is a checkbox, not a dropdown');
    assert.strictEqual(toggle.default, false, pair[0] + ': defaults to the install\'s own service');

    assert.ok(conn, pair[0] + ' still takes a connection');
    assert.ok(!conn.required, pair[0] + ': connection must NOT be required');
    // The whole point: it does not clutter the form unless asked for.
    assert.deepStrictEqual(conn.showWhen, { field: 'useCustomConnection', equals: true },
      pair[0] + ': connection must be hidden until the toggle is on');
  });
});

test('no provider field is asked for while there is only one provider', function() {
  // emailType was pure noise: one option, no decision to make.
  ALL.forEach(function(pair) {
    assert.ok(!pair[1].inputSchema.some(function(f) { return f.name === 'emailType'; }),
      pair[0] + ' should not ask for a provider');
  });
});

test('every input schema has unique, gapless ordering', function() {
  ALL.forEach(function(pair) {
    var orders = pair[1].inputSchema.map(function(f) { return f.order; });
    var expected = orders.map(function(_, i) { return i + 1; });
    assert.deepStrictEqual(orders, expected, pair[0] + ' fields must be ordered 1..n with no duplicates');
  });
});

test('an unconfigured system mailbox says WHICH variables are missing', async function() {
  var host = process.env.IMAP_HOST, shost = process.env.SMTP_HOST;
  delete process.env.IMAP_HOST; delete process.env.SMTP_HOST;
  try {
    var r = await actions.runAction({ name: 'email-read', input: {} });
    assert.strictEqual(r.status, 'failed');
    assert.match(r.error.message, /IMAP_HOST \(or SMTP_HOST\)/);
    // and it must point at the way out, not just the problem
    assert.match(r.error.message, /Provide my own connection/);
  } finally {
    if (host) process.env.IMAP_HOST = host;
    if (shost) process.env.SMTP_HOST = shost;
  }
});

test('ticking the box without supplying a connection is caught before connecting', async function() {
  var r = await actions.runAction({ name: 'email-read', input: { useCustomConnection: true } });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.error.message, /no connection was supplied/);
});

test('the system sender REFUSES fields it cannot carry rather than dropping them', async function() {
  // Silently losing a bcc is worse than refusing to send: one is a visible
  // error at build time, the other is a compliance question a year later.
  var base = { to: ['a@b.c'], subject: 'hi', html: '<p>x</p>' };
  var r = await actions.runAction({ name: 'email-send', input: Object.assign({ bcc: ['c@d.e'] }, base) });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.error.message, /does not support bcc/);
  assert.match(r.error.message, /own connection/);
});
