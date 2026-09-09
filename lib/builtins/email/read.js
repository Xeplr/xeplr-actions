// email-read action — list messages from a mailbox, newest first.
//
// STREAMING follows the older builtins convention (streaming_mode defaults
// FALSE), not db-fetch's: a mailbox read is bounded by `limit` (max 1000) and
// the normal case is a handful of messages a workflow branches on immediately.
// Set streaming_mode:true when pulling bodies in bulk — HTML mail with inline
// base64 images is large, and spooling keeps it off the heap and out of the
// run record. Temp file: XEPLR_ACTIONS_TMP_DIR, same as db-fetch.
//
// COST CONTROL is `body`, not `limit`. body:'none' skips downloading message
// sources entirely and fetches envelopes only — the right setting for a
// monitor that just needs ids to feed move/download steps.

var emailDrivers = require('../../drivers/email');
var emailConfig = require('../../drivers/email/config');
var crypto = require('crypto');
var os = require('os');
var path = require('path');
var fs = require('fs');
var fsp = require('fs/promises');

module.exports = {
  name: 'email-read',
  description: 'List messages from a mailbox folder, newest first, with optional ' +
               'unread/date/sender/subject filters. Returns message metadata and ' +
               '(optionally) bodies. Routes to the provider named by input.emailType.',
  requires: [],   // peer deps (imapflow/mailparser) checked at runtime

  // Which mailbox first — it is the only answer that changes what the rest of
  // the form means — then what to read out of it. The four narrowing filters
  // and the two output switches are `group`ed: real inputs, but a step that
  // just wants "the unread ones" should not have to scroll past six boxes it
  // is leaving empty. See send-email's schema for the showWhen/group split.
  inputSchema: [
    { name: 'useCustomConnection', type: 'boolean', default: false, order: 1,
      description: 'Off: use the mailbox this install is already configured with. On: supply your own below.' },
    { name: 'connection', type: 'object', order: 2,
      showWhen: { field: 'useCustomConnection', equals: true },
      description: '{ host, port, secure, user, password, tls? }' },

    { name: 'folder',           type: 'string',  default: 'INBOX', order: 3,
      description: 'Mailbox folder to read from.' },
    { name: 'unread_only',      type: 'boolean', default: false, order: 4,
      description: 'Only messages without the \\Seen flag.' },
    { name: 'limit',            type: 'number',  default: 50, order: 5,
      description: 'Max messages to return, newest first (1-1000).' },

    { name: 'since',            type: 'string',  order: 6, group: 'Filters',
      description: 'ISO 8601 date — server-side IMAP SINCE filter.' },
    { name: 'from_equals',      type: 'string',  order: 7, group: 'Filters',
      description: 'Exact sender address match (case-insensitive).' },
    { name: 'from_contains',    type: 'string',  order: 8, group: 'Filters',
      description: 'Substring match on sender address.' },
    { name: 'subject_contains', type: 'string',  order: 9, group: 'Filters',
      description: 'Substring match on subject.' },

    { name: 'body',             type: 'string',  default: 'full', order: 10, group: 'Output',
      description: '"full" (html+text), "text" (text only), or "none" (metadata only — much faster).' },
    { name: 'streaming_mode',   type: 'boolean', default: false, order: 11, group: 'Output',
      description: 'true → spool messages to an NDJSON file (output.filePath). false → inline output.messages.' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var system = ctx.system || {};

    var provider = emailDrivers.getInboundProvider(input.emailType);

    // 'system' resolves from env; 'custom' takes the step's own connection.

    var conn = emailConfig.resolveInbound(input);
    provider.checkRequires('email-read', { needsParser: (input.body || 'full') !== 'none' });

    var messages = await provider.read(conn, input);

    if (!input.streaming_mode) {
      return { messages: messages, messageCount: messages.length, streaming: false };
    }

    var filePath = await resolveOutputPath(system);
    var stats = await writeNDJSON(filePath, messages);
    return {
      filePath: filePath,
      format: 'jsonl',
      bytes: stats.bytes,
      messageCount: stats.rows,
      streaming: true
    };
  }
};

// ─── helpers ────────────────────────────────────────────────────────────

async function resolveOutputPath(system) {
  var dir = process.env.XEPLR_ACTIONS_TMP_DIR || path.join(os.tmpdir(), 'xeplr-actions');
  await fsp.mkdir(dir, { recursive: true });
  var base = (system.occurrenceId || crypto.randomBytes(6).toString('hex'))
    + '_email-read_' + crypto.randomBytes(6).toString('hex') + '.jsonl';
  return path.join(dir, base);
}

// One JSON object per line — the same NDJSON shape db-fetch emits, so the
// existing readers work unchanged. Honors write backpressure rather than
// queueing the whole array in memory, which is the entire point of spooling.
async function writeNDJSON(filePath, rows) {
  var ws = fs.createWriteStream(filePath, { encoding: 'utf8' });
  var count = 0;
  var bytes = 0;
  try {
    for (var i = 0; i < rows.length; i++) {
      var line = JSON.stringify(rows[i]) + '\n';
      bytes += Buffer.byteLength(line);
      count++;
      if (!ws.write(line)) {
        await new Promise(function(resolve, reject) {
          ws.once('drain', resolve);
          ws.once('error', reject);
        });
      }
    }
  } finally {
    await new Promise(function(resolve, reject) {
      ws.end(resolve);
      ws.once('error', reject);
    });
  }
  return { rows: count, bytes: bytes };
}
