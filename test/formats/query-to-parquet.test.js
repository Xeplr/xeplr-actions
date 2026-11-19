// A query's rows straight into Parquet (lib/formats/queryToParquet.js), on a
// real Postgres and a real DuckDB file: every row, each type as it came (text
// with commas, quotes and line breaks; an empty text apart from a null;
// numbers, dates, timestamps with and without a zone, true/false), shaped by
// `select`, read back exactly; a stop and the time limit end the database's
// work; what it cannot do is refused in words.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var db = require('../helpers/databases');
var pgTest = db.testWith('pg');
var parquet = require('../../lib/formats/parquet');
var duck = require('../../lib/drivers/db/duckdb');

var N = 200000;
function tmpDir(name) { return fs.mkdtempSync(path.join(os.tmpdir(), 'q2p-' + name + '-')); }
async function readAll(dir) { var out = []; for await (var r of parquet.readRows(dir)) out.push(r); return out; }

// The same rows in both databases: row 1 has every awkward value.
var PG_SQL = "SELECT g AS id, (g % 7)::numeric(10,2) * 1.5 AS amount, (g % 3 = 0) AS flag, " +
  "CASE WHEN g = 1 THEN 'a, \"quoted\"\nline' WHEN g = 2 THEN '' WHEN g = 3 THEN NULL ELSE 'v' || (g % 50) END AS note, " +
  "(DATE '2026-01-01' + (g % 365)) AS day, (TIMESTAMP '2026-01-01 05:46:00' + g * INTERVAL '1 minute') AS at, " +
  "(TIMESTAMPTZ '2026-01-01 00:30:00+00' + g * INTERVAL '1 hour') AS instant FROM generate_series(1, " + N + ") g";

pgTest('Postgres: every row and value, as it came', async function() {
  var dir = tmpDir('pg');
  try {
    var done = await parquet.writeQuery({ dbType: 'postgres', connection: db.config('pg', 'postgres'), sql: PG_SQL, dir: dir });
    assert.strictEqual(done.rows, N);
    assert.deepStrictEqual(done.columns.map(function(c) { return c.name + ':' + c.type; }),
      ['id:INTEGER', 'amount:DOUBLE', 'flag:BOOLEAN', 'note:VARCHAR', 'day:DATE', 'at:TIMESTAMP', 'instant:TIMESTAMPTZ']);
    assert.ok(fs.existsSync(path.join(dir, '_done')) && fs.existsSync(path.join(dir, 'part-00001.parquet')));
    var rows = await readAll(dir);
    assert.strictEqual(rows.length, N);
    var byId = {}; rows.forEach(function(r) { byId[r.id] = r; });
    assert.strictEqual(byId[1].note, 'a, "quoted"\nline', 'commas, quotes and a line break kept');
    assert.strictEqual(byId[2].note, '', 'an empty text stays empty');
    assert.strictEqual(byId[3].note, null, 'a null stays null');
    assert.strictEqual(byId[3].flag, true);
    assert.strictEqual(byId[7].amount, 0);
    assert.strictEqual(byId[8].amount, 1.5);
    assert.strictEqual(new Date(byId[1].instant).toISOString(), '2026-01-01T01:30:00.000Z', 'an instant keeps its moment');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

pgTest('Postgres: shaped by select, renamed and cast', async function() {
  var dir = tmpDir('pgsel');
  try {
    var seen = null;
    var done = await parquet.writeQuery({ dbType: 'postgres', connection: db.config('pg', 'postgres'), sql: PG_SQL, dir: dir,
      select: function(columns) { seen = columns; return 'CAST("amount" AS DOUBLE) AS y, "day" AS ds, 18 AS regressors_1'; } });
    assert.ok(seen && seen.length === 7, 'select is told the columns and their types');
    var rows = await readAll(dir);
    assert.strictEqual(done.rows, N);
    assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['ds', 'regressors_1', 'y']);
    assert.strictEqual(rows.find(function(r) { return r.y === 1.5; }).regressors_1, 18);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

pgTest('Postgres: a stop ends the query in the database', async function() {
  var dir = tmpDir('pgstop');
  var stop = new AbortController();
  var started = Date.now();
  setTimeout(function() { stop.abort(new Error('Stopped by request')); }, 500);
  try {
    await assert.rejects(parquet.writeQuery({ dbType: 'postgres', connection: db.config('pg', 'postgres'),
      sql: 'SELECT pg_sleep(30), 1 AS one', dir: dir, signal: stop.signal }), /Stopped by request/);
    assert.ok(Date.now() - started < 10000, 'not after the 30 s the query asked for');
    assert.ok(!fs.readdirSync(dir).some(function(f) { return /parquet|csv/.test(f); }), 'nothing half-written is left');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

pgTest('Postgres: the time limit too', async function() {
  var dir = tmpDir('pgtime');
  try {
    await assert.rejects(parquet.writeQuery({ dbType: 'postgres', connection: db.config('pg', 'postgres'),
      sql: 'SELECT pg_sleep(30), 1 AS one', dir: dir, timeoutMs: 300 }), /statement timeout/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DuckDB: the file writes itself, every row, shaped', async function() {
  var dir = tmpDir('duck');
  var file = path.join(dir, 'src.duckdb');
  var out = path.join(dir, 'out');
  try {
    var w = await duck.connect({ file: file, access: 'rw' });
    await duck.query(w, "CREATE TABLE t AS SELECT i AS id, (i % 7) * 1.5 AS amount, CASE WHEN i = 2 THEN '' WHEN i = 3 THEN NULL ELSE 'v' || i END AS note, " +
      "(DATE '2026-01-01' + (i % 365)::INTEGER) AS day FROM range(1, " + (N + 1) + ") r(i)", []);
    await duck.close(w);
    var done = await parquet.writeQuery({ dbType: 'duckdb', connection: { file: file }, sql: 'SELECT * FROM t WHERE id > 0', dir: out,
      select: function(columns) { return columns.map(function(c) { return duck.quoteIdent(c.name); }).join(', ') + ', 7 AS seven'; } });
    assert.strictEqual(done.rows, N);
    var rows = await readAll(out);
    var r2 = rows.find(function(r) { return Number(r.id) === 2; }), r3 = rows.find(function(r) { return Number(r.id) === 3; });
    assert.strictEqual(r2.note, '');
    assert.strictEqual(r3.note, null);
    assert.strictEqual(r2.seven, 7);
    // Read only: the source file is never written.
    var mtime = fs.statSync(file).mtimeMs;
    await parquet.writeQuery({ dbType: 'duckdb', connection: { file: file }, sql: 'SELECT id FROM t', dir: path.join(dir, 'again') });
    assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('what it cannot do is refused in words', async function() {
  await assert.rejects(parquet.writeQuery({ dbType: 'mysql', sql: 'SELECT 1', dir: tmpDir('my') }), /only from duckdb or postgres, not mysql/);
  await assert.rejects(parquet.writeQuery({ dbType: 'duckdb', sql: 'SELECT 1' }), /Give the folder/);
  var dir = tmpDir('full');
  fs.writeFileSync(path.join(dir, 'part-00001.parquet'), 'x');
  await assert.rejects(parquet.writeQuery({ dbType: 'duckdb', connection: { file: ':memory:' }, sql: 'SELECT 1', dir: dir }), /already holds Parquet parts/);
  var stop = new AbortController(); stop.abort('Stopped first');
  await assert.rejects(parquet.writeQuery({ dbType: 'duckdb', connection: { file: ':memory:' }, sql: 'SELECT 1', dir: tmpDir('pre'), signal: stop.signal }), /Stopped first/);
  fs.rmSync(dir, { recursive: true, force: true });
});
