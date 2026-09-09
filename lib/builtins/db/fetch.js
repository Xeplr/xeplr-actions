// db-fetch action — routes to getDriver(input.dbType), then streams rows out
// of the source via driver.fetchStream (a server-side cursor / native stream,
// never buffering the whole result set).
//
// STREAMING BY DEFAULT. Unlike the older builtins convention (streaming_mode
// defaults false), db-fetch defaults streaming_mode=TRUE: rows are spooled to
// an NDJSON temp file and the action returns { filePath, format, bytes, rows }.
// That output plugs straight into db-push's `filePath` input for cross-engine
// replication with a bounded memory footprint at both ends.
//
// Set streaming_mode:false ONLY for known-small reads — it buffers the full
// result set into output.rows (still read via the streaming cursor internally).
//
//   modes:
//     'table'  → SELECT * FROM <table>            (input.table required)
//     'query'  → raw input.sql (+ input.params)   (input.sql required)
//   Temp file: XEPLR_ACTIONS_TMP_DIR (default os.tmpdir()/xeplr-actions),
//   named <occurrenceId>_db-fetch_<seq>.jsonl. Cleanup: none in-action — rely
//   on the sweep-temp-files action (or db-push after it consumes the file).

var dbDrivers  = require('../../drivers/db');
var { generateId } = require('@xeplr/utils/lib/helpers');
var os = require('os');
var path = require('path');
var fs = require('fs');
var fsp = require('fs/promises');

module.exports = {
  name: 'db-fetch',
  description: 'Stream rows out of a source DB table or query. Streaming by default: ' +
               'spools to an NDJSON file (output.filePath) consumable by db-push. ' +
               'Routes to the driver named by input.dbType.',
  requires: [],   // per-driver requires checked at runtime once dbType is known

  inputSchema: [
    // ── WHICH DATABASE ──────────────────────────────────────────────────
    //
    // Two routes in, and only one of them is fit for a UI.
    //
    // connectionInfoId + dbInfoId — pick a SAVED connection. The ids are all
    // that is ever stored or sent to a browser; the host swaps them for real
    // credentials server-side, immediately before this runs (see @xeplr/jobs'
    // resolveInputs). dbType comes from the connection too, because the
    // connection already knows what it is.
    //
    // connection + dbType — pass the login literally. Kept because this
    // package must work with no host at all: a script, a test, a standalone
    // worker. NOT for the job editor — a job's inputs are fetched by the
    // browser on every list load and snapshotted into every occurrence row,
    // so a password there is a password everywhere, forever.
    { name: 'connectionInfoId', type: 'string', order: 1,
      optionsFrom: 'connections',
      description: 'A saved connection. Resolved to credentials server-side.' },
    { name: 'dbInfoId',         type: 'string', order: 2,
      optionsFrom: 'databases', dependsOn: 'connectionInfoId',
      description: 'Which database on that connection.' },

    // Filled by the host from the two ids above, or supplied literally by a
    // caller with no host. `system` keeps them out of the form either way —
    // they must stay DECLARED, because @xeplr/schema-handler drops any field
    // a schema does not mention, which would strip the resolved connection on
    // its way to execute().
    { name: 'dbType',         type: 'string',  required: true, default: 'postgres', order: 3,
      system: true, options: ['postgres', 'mysql', 'mssql'],
      description: 'Taken from the connection when one is chosen.' },
    { name: 'connection',     type: 'object',  required: true, order: 4,
      system: true,
      description: 'Connection config: { host, port, user, password, database }' },
    { name: 'mode',           type: 'string',  default: 'table', order: 3,
      description: '"table" (SELECT * FROM input.table) or "query" (raw input.sql)' },
    { name: 'table',          type: 'string',  order: 4,
      description: 'Source table name (mode="table").' },
    { name: 'sql',            type: 'string',  order: 5,
      description: 'Raw SQL to stream (mode="query").' },
    { name: 'params',         type: 'array',   order: 6,
      description: 'Bind params for mode="query".' },
    { name: 'streaming_mode', type: 'boolean', default: true, order: 7, group: 'Performance',
      description: 'Default TRUE → spool to NDJSON file. false → inline output.rows (small reads only).' },
    { name: 'batchSize',      type: 'number',  default: 1000, order: 8, group: 'Performance',
      description: 'Rows pulled per cursor round-trip / stream highWaterMark.' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var system = ctx.system || {};

    var driver = dbDrivers.getDriver(input.dbType);
    dbDrivers.checkDriverRequires('db-fetch', input.dbType, driver);
    if (typeof driver.fetchStream !== 'function') {
      throw new Error('db-fetch: driver "' + input.dbType + '" does not implement fetchStream yet');
    }

    var built = buildFetchSql(driver, input);
    var streaming = input.streaming_mode !== false;   // default TRUE
    var pool = await driver.connect(input.connection);

    try {
      var rowStream = driver.fetchStream(pool, {
        sql: built.sql, params: built.params, batchSize: input.batchSize || 1000
      });

      if (!streaming) {
        var rows = [];
        for await (var row of rowStream) rows.push(row);
        return { rows: rows, rowCount: rows.length, streaming: false };
      }

      var filePath = await resolveOutputPath(system);
      var stats = await writeNDJSON(filePath, rowStream);
      return {
        filePath:  filePath,
        format:    'jsonl',
        bytes:     stats.bytes,
        rows:      stats.rows,
        streaming: true
      };
    } finally {
      await driver.close(pool);
    }
  }
};

// ─── helpers ────────────────────────────────────────────────────────────

function buildFetchSql(driver, input) {
  var mode = input.mode || (input.table ? 'table' : 'query');
  if (mode === 'table') {
    if (!input.table) throw new Error('db-fetch: mode "table" requires input.table');
    return { sql: 'SELECT * FROM ' + driver.quoteIdent(input.table), params: [] };
  }
  if (mode === 'query') {
    if (!input.sql) throw new Error('db-fetch: mode "query" requires input.sql');
    return { sql: input.sql, params: input.params || [] };
  }
  throw new Error('db-fetch: unsupported mode "' + mode + '" (use "table" or "query")');
}


async function resolveOutputPath(system) {
  var dir = process.env.XEPLR_ACTIONS_TMP_DIR || path.join(os.tmpdir(), 'xeplr-actions');
  await fsp.mkdir(dir, { recursive: true });
  var base = (system.occurrenceId || generateId()) + '_db-fetch_' + generateId() + '.jsonl';
  return path.join(dir, base);
}
// Write an async iterable of rows to an NDJSON file, honoring write
// backpressure (await 'drain' when the OS buffer is full). One JSON object
// per line — the exact shape db-push's filePath reader expects.
async function writeNDJSON(filePath, rowIterable) {
  var ws = fs.createWriteStream(filePath, { encoding: 'utf8' });
  var rows = 0;
  var bytes = 0;
  try {
    for await (var row of rowIterable) {
      var line = JSON.stringify(row) + '\n';
      bytes += Buffer.byteLength(line);
      rows++;
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
  return { rows: rows, bytes: bytes };
}
