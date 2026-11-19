// Parquet — read and write, through DuckDB. No JavaScript Parquet library:
// DuckDB is already a peer here, writes Parquet in native code across
// threads, and keeps decimals, dates and timestamps the way pandas and
// pyarrow read them back.
//
// ── WRITING: a folder of parts ──────────────────────────────────────────
//
// A Parquet file cannot be appended to, and its index is written last, so a
// stream of rows becomes a FOLDER of part files:
//
//   <dir>/part-00001.parquet   each partRows rows (default 100,000)
//   <dir>/part-00002.parquet
//   <dir>/_done                written last: every part is complete
//
// Rows are appended into a table in a DuckDB of their own, in memory; at
// partRows the table is copied out as the next part and emptied. Memory stays
// about one part whatever the total, and every row is written to disk once.
// A part is written under a dot-name and renamed when complete, so nothing
// ever reads half a part. pandas (`read_parquet(dir)`), pyarrow and DuckDB
// (`'<dir>/*.parquet'`) all read the folder as one table and skip `_done`.
//
// `file` instead of `dir` writes ONE file at close — for an export somebody
// downloads. Its rows are held in memory until then, so it is for bounded row
// counts, not for a stream of unknown size.
//
// ── TYPES ───────────────────────────────────────────────────────────────
//
// Declared (`columns: [{ name, type }]`, the logical types every driver
// speaks) or, when not, inferred from the first scanRows rows with the
// uploader's own inference (uploader/infer.js). A column with no value yet in
// those rows keeps the scan going until it has one — a column empty for its
// first thousand rows is still numbers after them, not text — up to one
// part's worth (partRows, 100,000) of rows; empty that long, it is text. The DuckDB driver's type map
// and value coercion are used as they are, so a value lands in a .parquet
// file exactly as it would in a DuckDB table: 'number' is DOUBLE, 'datetime'
// is TIMESTAMPTZ, 'date' DATE, objects and arrays JSON.
//
// A value that does not fit its column fails the write naming the row and
// the column — never stored as something else. A key no earlier row had
// fails it too: a Parquet folder has one set of columns, and dropping a
// field quietly is worse than stopping. Declare the columns when the first
// rows do not show them all. Our own bookkeeping columns (__xeplr_…__) never
// come along, as in every load.
//
// ── READING ─────────────────────────────────────────────────────────────
//
// readRows(path) streams a file or a folder of parts, a chunk at a time,
// through the DuckDB driver's own fetchStream — the same values a DuckDB
// table gives (dates as Date, BIGINT narrowed, a JSON column as its text).

var fs = require('fs');
var path = require('path');
var duck = require('../drivers/db/duckdb');
var { inferColumns } = require('../uploader/infer');
var { isInternalColumn } = require('../drivers/db/internalTables');

var PART_ROWS = 100000;
var SCAN_ROWS = 1000;
var DONE = '_done';
var TABLE = 'rows';

function literal(p) { return "'" + String(p).replace(/'/g, "''") + "'"; }
function partName(n) { return 'part-' + String(n).padStart(5, '0') + '.parquet'; }

/** The path DuckDB reads: a file as it is, a folder as its parts. */
function sourceOf(target) {
  return fs.statSync(target).isDirectory() ? path.join(target, '*.parquet') : target;
}

/**
 * True when `target` is a .parquet file, or a folder of parts — including one
 * this writer finished with no rows (only `_done`), which reads as empty.
 */
function isParquet(target) {
  try {
    var st = fs.statSync(target);
    if (st.isFile()) return /\.parquet$/i.test(target);
    return st.isDirectory() && fs.readdirSync(target).some(function(f) { return /\.parquet$/i.test(f) || f === DONE; });
  } catch (_) { return false; }
}

/** Whether there is anything to read: a file, or a folder with at least one part. */
function hasRows(target) {
  var st = fs.statSync(target);
  return st.isFile() || fs.readdirSync(target).some(function(f) { return /\.parquet$/i.test(f); });
}

/**
 * Open a writer.
 *
 * @param {object} opts
 *   dir       folder to write parts into (created if missing), or
 *   file      one .parquet file, written at close
 *   columns   [{ name, type }] — declared; otherwise inferred
 *   partRows  rows per part (dir only), default 100,000
 *   scanRows  rows read before inferring types, default 1,000 — more
 *             while a column has had no value, up to partRows (100,000)
 * @returns {{ write(row): Promise<void>, close(): Promise<object>, abort(): Promise<void> }}
 *   close() → { path, parts: [names], rows, bytes, columns }
 */
function open(opts) {
  opts = opts || {};
  if (!opts.dir === !opts.file) throw new Error('parquet: give a dir (parts) or a file — one of them.');
  var single = Boolean(opts.file);
  var target = single ? opts.file : opts.dir;
  fs.mkdirSync(single ? path.dirname(target) : target, { recursive: true });
  var partRows = single ? Infinity : Math.max(1, opts.partRows || PART_ROWS);
  var scanRows = Math.max(1, opts.scanRows || SCAN_ROWS);
  // How long a column with no value yet may hold the types back: one part.
  var scanUntil = Math.max(scanRows, single ? PART_ROWS : partRows);

  var instance = null, conn = null, appender = null;
  var columns = null, known = null;
  var buffer = [];
  // While scanning: the columns seen, and those still without a value.
  var unvalued = new Set();
  var valued = new Set();
  var rows = 0, inPart = 0;
  var parts = [], written = [];
  var finished = false;

  async function start() {
    var declared = (opts.columns && opts.columns.length) ? opts.columns : inferColumns(buffer);
    columns = declared.filter(function(c) { return !isInternalColumn(c); })
      .map(function(c) { return { name: c.name, type: c.type || 'string' }; });
    known = new Set(columns.map(function(c) { return c.name; }));
    var held = buffer;
    buffer = null;
    if (!columns.length) return;
    var api = require('@duckdb/node-api');
    instance = await api.DuckDBInstance.create(':memory:', { TimeZone: 'UTC' });
    conn = await instance.connect();
    await conn.run('CREATE TABLE ' + TABLE + ' (' + columns.map(function(c) {
      return duck.quoteIdent(c.name) + ' ' + duck.toPgType(c.type);
    }).join(', ') + ')');
    appender = await conn.createAppender(TABLE);
    for (var i = 0; i < held.length; i++) await append(held[i], rows - held.length + i + 1);
  }

  function refuse(n, message) {
    return Object.assign(new Error('Row ' + n.toLocaleString('en-IN') + ': ' + message), { code: 'PARQUET_ROW' });
  }

  async function append(row, n) {
    for (var k in row) {
      if (!known.has(k) && !isInternalColumn(k)) {
        throw refuse(n, 'it has a column "' + k + '" that the rows before it did not. ' +
          'Declare the columns when the first rows do not show them all.');
      }
    }
    for (var i = 0; i < columns.length; i++) {
      var c = columns[i];
      var v = duck.coerceValue(row[c.name], c.type);
      try {
        if (v === null) appender.appendNull();
        else if (typeof v === 'number' && c.type === 'number') appender.appendDouble(v);
        else if (typeof v === 'boolean' && c.type === 'boolean') appender.appendBoolean(v);
        else appender.appendVarchar(String(v));
      } catch (err) {
        throw refuse(n, 'column "' + c.name + '" (' + c.type + ') cannot hold ' + JSON.stringify(row[c.name]) + ' — ' + err.message);
      }
    }
    appender.endRow();
    inPart++;
    if (inPart >= partRows) await flush();
  }

  // Copy the table out as the next part, under a dot-name until it is whole.
  async function flush() {
    appender.closeSync();
    var name = single ? path.basename(target) : partName(parts.length + 1);
    var dest = single ? target : path.join(target, name);
    var tmp = path.join(path.dirname(dest), '.' + path.basename(dest) + '.tmp');
    written.push(tmp);
    await conn.run('COPY ' + TABLE + ' TO ' + literal(tmp) + ' (FORMAT parquet, COMPRESSION zstd)');
    fs.renameSync(tmp, dest);
    written[written.length - 1] = dest;
    parts.push(name);
    inPart = 0;
    await conn.run('DELETE FROM ' + TABLE);
    appender = await conn.createAppender(TABLE);
  }

  function shut() {
    try { if (appender) appender.closeSync(); } catch (_) {}
    try { if (conn) conn.closeSync(); } catch (_) {}
    try { if (instance) instance.closeSync(); } catch (_) {}
    appender = conn = instance = null;
  }

  return {
    write: async function(row) {
      if (finished) throw new Error('parquet: write after close');
      rows++;
      if (buffer) {
        buffer.push(row || {});
        for (var k in row) {
          if (valued.has(k)) continue;
          if (row[k] === null || row[k] === undefined) unvalued.add(k);
          else { valued.add(k); unvalued.delete(k); }
        }
        var waiting = !(opts.columns && opts.columns.length) && unvalued.size > 0;
        if (buffer.length >= (waiting ? scanUntil : scanRows)) await start();
        return;
      }
      if (columns.length) return append(row || {}, rows);
      // No columns: the first rows had none. A later one with fields is refused, never dropped.
      var extra = Object.keys(row || {}).filter(function(k) { return !isInternalColumn(k); });
      if (extra.length) throw refuse(rows, 'it has a column "' + extra[0] + '" that the rows before it did not.');
    },

    close: async function() {
      if (finished) throw new Error('parquet: closed twice');
      finished = true;
      try {
        if (buffer) await start();
        // One part even when empty, so a reader still finds the columns.
        // With no rows and none declared there are no columns to write.
        if (columns.length && (inPart > 0 || parts.length === 0)) await flush();
        if (!single) fs.writeFileSync(path.join(target, DONE), JSON.stringify({ rows: rows, parts: parts.length }) + '\n');
      } finally {
        shut();
      }
      var bytes = parts.reduce(function(sum, name) {
        return sum + fs.statSync(single ? target : path.join(target, name)).size;
      }, 0);
      return { path: target, parts: parts, rows: rows, bytes: bytes, columns: columns };
    },

    /** Stop and remove what this writer wrote. The folder itself is the caller's. */
    abort: async function() {
      finished = true;
      shut();
      written.forEach(function(f) { try { fs.rmSync(f, { force: true }); } catch (_) {} });
      if (!single) { try { fs.rmSync(path.join(target, DONE), { force: true }); } catch (_) {} }
    }
  };
}

/** Write every row of an (async) iterable; aborts and rethrows on failure. */
async function writeAll(rowIterable, opts) {
  var w = open(opts);
  try {
    for await (var row of rowIterable) {
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('Stopped by request'), { code: 'STOPPED' });
      await w.write(row);
    }
    return await w.close();
  } catch (err) {
    await w.abort();
    throw err;
  }
}

// Reading goes through a shared in-memory DuckDB: read_parquet keeps no state
// in it, so callers never meet each other there.
async function withReader(fn) {
  var pool = await duck.connect({ file: ':memory:', access: 'rw' });
  try { return await fn(pool); } finally { await duck.close(pool); }
}

/** A file's or a folder's columns, as logical types: [{ name, type }]. */
async function columnsOf(target) {
  if (!isParquet(target) || !hasRows(target)) return [];
  return withReader(async function(pool) {
    var res = await duck.query(pool, 'DESCRIBE SELECT * FROM read_parquet(' + literal(sourceOf(target)) + ')', []);
    return res.rows.map(function(r) { return { name: r.column_name, type: duck.dataTypeToLogical(r.column_type) }; });
  });
}

/** Stream the rows of a .parquet file or a folder of parts. */
async function* readRows(target, opts) {
  opts = opts || {};
  if (!isParquet(target)) throw new Error('parquet: "' + target + '" is not a .parquet file or a folder of parts.');
  if (!hasRows(target)) return;
  var pool = await duck.connect({ file: ':memory:', access: 'rw' });
  try {
    yield* duck.fetchStream(pool, { sql: 'SELECT * FROM read_parquet(' + literal(sourceOf(target)) + ')', signal: opts.signal });
  } finally {
    await duck.close(pool);
  }
}

module.exports = {
  // As a source format (formats/index.js): file-upload and columnsOf take a path.
  requires: ['@duckdb/node-api'],
  inputMode: 'path',
  parsePath: function(filePath, opts) { return readRows(filePath, opts); },

  open: open,
  writeAll: writeAll,
  // A query's rows written by the database itself, no row through JavaScript
  // (queryToParquet.js): DuckDB and Postgres.
  writeQuery: function(opts) { return require('./queryToParquet').writeQuery(opts); },
  readRows: readRows,
  columnsOf: columnsOf,
  isParquet: isParquet,
  PART_ROWS: PART_ROWS,
  DONE: DONE
};
