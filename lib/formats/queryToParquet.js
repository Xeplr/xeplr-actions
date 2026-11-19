// A QUERY'S ROWS, STRAIGHT INTO PARQUET — with no row passing through
// JavaScript. The writer beside it (parquet.js open/write) takes rows one at
// a time from a stream, which is right when every row needs work on the way;
// when none does, the database can hand the whole result over at once:
//
//   duckdb    COPY (SELECT …) TO '<part>.parquet' — DuckDB writes it itself,
//             in native code, across threads
//   postgres  COPY (SELECT …) TO STDOUT as CSV (one bulk export, bytes piped
//             to a file, never parsed here), then an in-memory DuckDB reads
//             that file with each column's own type and writes the part.
//             No DuckDB extension is needed (none can be downloaded on a
//             server that only reaches npm and PyPI).
//
// The result is the same folder parquet.open({ dir }) writes: one part,
// part-00001.parquet, and `_done` written last — pandas, pyarrow and DuckDB
// read it as they read any other.
//
// `select(columns)` shapes what is written, as a DuckDB select list over the
// query's columns ([{ name, type }] with DuckDB types): renames, casts,
// constants. Without it, every column as it is.
//
// `sql` must carry no parameters: Postgres's COPY takes none, so the caller
// inlines its values first (BI: query-engine inlineParams). A stop (`signal`)
// or the time limit (`timeoutMs`) ends the database's work, not only ours.
var fs = require('fs');
var path = require('path');
var duck = require('../drivers/db/duckdb');

var DONE = '_done';
var PART = 'part-00001.parquet';

function literal(p) { return "'" + String(p).replace(/'/g, "''") + "'"; }
function refuse(message) { return Object.assign(new Error(message), { code: 'QUERY_TO_PARQUET' }); }

/** What each Postgres type is to DuckDB; anything else is text. */
var PG_TYPES = {
  16: 'BOOLEAN', 20: 'BIGINT', 21: 'SMALLINT', 23: 'INTEGER', 26: 'BIGINT',
  700: 'REAL', 701: 'DOUBLE', 1700: 'DOUBLE',
  1082: 'DATE', 1083: 'TIME', 1114: 'TIMESTAMP', 1184: 'TIMESTAMPTZ'
};

/** The database types this can read straight through. */
var SUPPORTED = ['duckdb', 'postgres'];

function stopped(signal) {
  var why = signal && signal.reason;
  return why instanceof Error ? why : refuse(typeof why === 'string' ? why : 'Stopped');
}

/**
 * @param {object} opts
 *   dbType      'duckdb' | 'postgres' (SUPPORTED)
 *   connection  the login (Postgres: { host, port, user, password, database };
 *               DuckDB: { file })
 *   sql         the query, its values inlined (no $1, no ?)
 *   dir         the folder to write (created; must hold no parts yet)
 *   select      (columns) → DuckDB select list; default '*'
 *   signal      AbortSignal: a stop
 *   timeoutMs   the most the database may take
 * @returns {Promise<{ path, rows, bytes, columns }>}
 */
async function writeQuery(opts) {
  opts = opts || {};
  if (SUPPORTED.indexOf(opts.dbType) === -1) throw refuse('A query is written straight to Parquet only from ' + SUPPORTED.join(' or ') + ', not ' + opts.dbType + '.');
  if (!opts.dir) throw refuse('Give the folder to write.');
  if (opts.signal && opts.signal.aborted) throw stopped(opts.signal);
  fs.mkdirSync(opts.dir, { recursive: true });
  if (fs.readdirSync(opts.dir).some(function(f) { return /\.parquet$/i.test(f) || f === DONE; })) throw refuse(opts.dir + ' already holds Parquet parts.');
  var part = path.join(opts.dir, PART);
  var tmp = path.join(opts.dir, '.' + PART + '.tmp');
  try {
    var columns = opts.dbType === 'duckdb' ? await fromDuckdb(opts, tmp) : await fromPostgres(opts, tmp);
    var rows = await countParquet(tmp);
    fs.renameSync(tmp, part);
    fs.writeFileSync(path.join(opts.dir, DONE), '');
    return { path: opts.dir, rows: rows, bytes: fs.statSync(part).size, columns: columns };
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (opts.signal && opts.signal.aborted) throw stopped(opts.signal);
    throw err;
  }
}

function selectOf(opts, columns) {
  var list = typeof opts.select === 'function' ? opts.select(columns) : '*';
  return list && String(list).trim() ? list : '*';
}

// ── DuckDB: the file writes itself ──────────────────────────────────────
async function fromDuckdb(opts, tmp) {
  var pool = await duck.connect(Object.assign({}, opts.connection, { access: 'ro' }));
  var q = { signal: opts.signal, timeoutMs: opts.timeoutMs };
  try {
    var described = await duck.query(pool, 'DESCRIBE SELECT * FROM (' + opts.sql + ') AS q', [], q);
    var columns = (described.rows || []).map(function(r) { return { name: r.column_name, type: r.column_type }; });
    await duck.query(pool, 'COPY (SELECT ' + selectOf(opts, columns) + ' FROM (' + opts.sql + ') AS q) TO ' + literal(tmp) +
      ' (FORMAT parquet, COMPRESSION zstd)', [], q);
    return columns;
  } finally {
    await duck.close(pool).catch(function() {});
  }
}

// ── Postgres: one bulk export, then DuckDB writes the part ──────────────
async function fromPostgres(opts, tmp) {
  var pg = require('pg');
  var copyTo = require('pg-copy-streams').to;
  var { pipeline } = require('stream/promises');
  var csv = path.join(opts.dir, '.rows.csv');
  var c = opts.connection || {};
  var client = new pg.Client({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database, connectionTimeoutMillis: 15000 });
  await client.connect();
  var onStop = function() {
    // The database stops too: cancel from a connection of its own.
    var killer = new pg.Client({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database });
    killer.connect().then(function() { return killer.query('SELECT pg_cancel_backend($1)', [client.processID]); })
      .catch(function() {}).then(function() { return killer.end(); }).catch(function() {});
  };
  if (opts.signal) opts.signal.addEventListener('abort', onStop, { once: true });
  var columns;
  try {
    if (opts.timeoutMs) await client.query('SET statement_timeout = ' + Math.max(1, Math.floor(opts.timeoutMs)));
    var shape = await client.query('SELECT * FROM (' + opts.sql + ') AS q LIMIT 0');
    columns = shape.fields.map(function(f) { return { name: f.name, type: PG_TYPES[f.dataTypeID] || 'VARCHAR' }; });
    await pipeline(client.query(copyTo('COPY (SELECT * FROM (' + opts.sql + ') AS q) TO STDOUT WITH (FORMAT csv, HEADER true)')), fs.createWriteStream(csv));
  } catch (err) {
    fs.rmSync(csv, { force: true });
    throw err;
  } finally {
    if (opts.signal) opts.signal.removeEventListener('abort', onStop);
    await client.end().catch(function() {});
  }
  if (opts.signal && opts.signal.aborted) { fs.rmSync(csv, { force: true }); throw stopped(opts.signal); }

  var api = require('@duckdb/node-api');
  var instance = await api.DuckDBInstance.create(':memory:', { TimeZone: 'UTC' });
  var conn = await instance.connect();
  try {
    // Each column read as its own type. Postgres writes NULL as nothing and
    // an empty text as "" — so a quoted empty stays text, not a null.
    var types = '{' + columns.map(function(col) { return literal(col.name) + ': ' + literal(col.type); }).join(', ') + '}';
    var read = 'read_csv(' + literal(csv) + ', header = true, auto_detect = false, columns = ' + types + ', allow_quoted_nulls = false, quote = \'"\', escape = \'"\')';
    await conn.run('COPY (SELECT ' + selectOf(opts, columns) + ' FROM ' + read + ' AS q) TO ' + literal(tmp) + ' (FORMAT parquet, COMPRESSION zstd)');
  } finally {
    conn.closeSync();
    fs.rmSync(csv, { force: true });
  }
  return columns;
}

async function countParquet(file) {
  var api = require('@duckdb/node-api');
  var instance = await api.DuckDBInstance.create(':memory:');
  var conn = await instance.connect();
  try {
    var reader = await conn.runAndReadAll('SELECT count(*) AS n FROM read_parquet(' + literal(file) + ')');
    return Number(reader.getRowObjects()[0].n);
  } finally {
    conn.closeSync();
  }
}

module.exports = { writeQuery: writeQuery, SUPPORTED: SUPPORTED, PG_TYPES: PG_TYPES };
