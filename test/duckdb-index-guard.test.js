// A WRITTEN DUCKDB FILE KEEPS NO INDEX — and the failure that rule exists for,
// brought about for real: a process killed with rows only in the WAL, the file
// reopened and checkpointed, then a DELETE.
//
// DuckDB 1.5.4–1.5.6 (duckdb/duckdb#26106): the replay puts the rows back in
// the table, the next checkpoint drops them from every index on it, and the
// DELETE fails with "Failed to delete all rows from index" — FATAL, and the
// whole file unusable until restart. The first test proves that still happens
// on the DuckDB this package pins; the rest prove the driver never lets it.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs'), os = require('os'), path = require('path');
var spawnSync = require('child_process').spawnSync;
var api = require('@duckdb/node-api');
var duck = require('../lib/drivers/db/duckdb');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-guard-')); }

// A process that writes to `file` with raw DuckDB (no driver, as a file from
// before this rule was written) and is SIGKILLed with its last rows only in
// the WAL — the API dying mid-load.
function writeThenDie(file, withIndex) {
  var script = [
    "const { DuckDBInstance } = require(" + JSON.stringify(require.resolve('@duckdb/node-api')) + ");",
    "(async () => {",
    "  const db = await DuckDBInstance.create(" + JSON.stringify(file) + "); const c = await db.connect();",
    "  await c.run('CREATE TABLE t (id INTEGER, k VARCHAR)');",
    withIndex ? "  await c.run('CREATE UNIQUE INDEX t_k ON t (k)');" : "",
    "  await c.run('CHECKPOINT');",
    "  await c.run(\"INSERT INTO t SELECT i, 'k' || i FROM range(500) r(i)\");",
    "  process.kill(process.pid, 'SIGKILL');",
    "})();"
  ].join('\n');
  var r = spawnSync(process.execPath, ['-e', script]);
  assert.strictEqual(r.signal, 'SIGKILL', 'the writer died as a crash, not a clean exit');
  assert.ok(fs.existsSync(file + '.wal'), 'it left a WAL behind');
}

// Reopen with raw DuckDB and close: the WAL replays, the close checkpoints.
// After this a file with an index is in the damaged state.
async function replayAndClose(file) {
  var db = await api.DuckDBInstance.create(file); var c = await db.connect();
  await c.run('SELECT count(*) FROM t');
  c.closeSync(); db.closeSync();
}

async function rawDelete(file) {
  var db = await api.DuckDBInstance.create(file); var c = await db.connect();
  try { await c.run('DELETE FROM t'); return null } catch (e) { return e.message } finally { c.closeSync(); db.closeSync(); }
}

test('the failure is real on the pinned DuckDB: an index, a crash, a checkpoint, then DELETE is FATAL', async function() {
  var dir = scratch(); var file = path.join(dir, 'w.duckdb');
  try {
    writeThenDie(file, true);
    await replayAndClose(file);
    var err = await rawDelete(file);
    assert.match(String(err), /Failed to delete all rows from index/, 'if this stops failing, DuckDB fixed #26106');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the same crash with no index: the DELETE simply works', async function() {
  var dir = scratch(); var file = path.join(dir, 'w.duckdb');
  try {
    writeThenDie(file, false);
    await replayAndClose(file);
    assert.strictEqual(await rawDelete(file), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file already damaged by it: the driver\'s read-write open drops the index, and the DELETE works', async function() {
  var dir = scratch(); var file = path.join(dir, 'w.duckdb');
  try {
    writeThenDie(file, true);
    await replayAndClose(file);                     // damaged, as the copy was on 28 Sep
    var pool = await duck.connect({ file: file, access: 'rw' });
    try {
      assert.strictEqual(Number((await duck.query(pool, 'SELECT count(*) AS n FROM duckdb_indexes()', [])).rows[0].n), 0, 'no index left');
      var del = await duck.query(pool, 'DELETE FROM t', []);
      assert.strictEqual(del.rowCount, 500, 'every row deleted');
    } finally { await duck.close(pool); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('checkpoint first, on its own: even a file that keeps its index survives the crash', async function() {
  // keepIndexes, so only the checkpoint-on-open is being tested. Without it,
  // the driver's open replays the WAL, its close checkpoints, and the DELETE
  // after that is the FATAL one.
  var dir = scratch(); var file = path.join(dir, 'w.duckdb');
  try {
    writeThenDie(file, true);
    var first = await duck.connect({ file: file, access: 'rw', keepIndexes: true });
    assert.strictEqual(Number((await duck.query(first, 'SELECT count(*) AS n FROM t', [])).rows[0].n), 500, 'the replayed rows are there');
    await duck.close(first);
    var later = await duck.connect({ file: file, access: 'rw', keepIndexes: true });
    try {
      assert.strictEqual(Number((await duck.query(later, 'SELECT count(*) AS n FROM duckdb_indexes()', [])).rows[0].n), 1, 'the index was kept');
      assert.strictEqual((await duck.query(later, 'DELETE FROM t', [])).rowCount, 500);
    } finally { await duck.close(later); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CREATE INDEX is refused on a written file, and allowed only when asked for', async function() {
  var dir = scratch(); var file = path.join(dir, 'w.duckdb');
  try {
    var pool = await duck.connect({ file: file, access: 'rw' });
    await duck.query(pool, 'CREATE TABLE t (id INTEGER)', []);
    await assert.rejects(duck.query(pool, 'CREATE UNIQUE INDEX t_id ON t (id)', []), /CREATE INDEX refused/);
    await assert.rejects(duck.query(pool, '  create index t_id2 on t (id)', []), /CREATE INDEX refused/);
    await assert.rejects(duck.ensureUpsertIndex(pool, 't', ['id']), /CREATE INDEX refused/);
    await duck.close(pool);

    var keep = await duck.connect({ file: file, access: 'rw', keepIndexes: true });
    await duck.query(keep, 'CREATE INDEX t_id ON t (id)', []);
    await duck.close(keep);
    var again = await duck.connect({ file: file, access: 'rw' });
    assert.strictEqual(Number((await duck.query(again, 'SELECT count(*) AS n FROM duckdb_indexes()', [])).rows[0].n), 0, 'the next ordinary open drops it');
    await duck.close(again);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a read-only open changes nothing in the file', async function() {
  var dir = scratch(); var file = path.join(dir, 'w.duckdb');
  try {
    var keep = await duck.connect({ file: file, access: 'rw', keepIndexes: true });
    await duck.query(keep, 'CREATE TABLE t (id INTEGER)', []);
    await duck.query(keep, 'CREATE INDEX t_id ON t (id)', []);
    await duck.close(keep);
    var ro = await duck.connect({ file: file });
    assert.strictEqual(Number((await duck.query(ro, 'SELECT count(*) AS n FROM duckdb_indexes()', [])).rows[0].n), 1);
    await duck.close(ro);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the uploader stages every DuckDB upsert, asked or not', function() {
  assert.strictEqual(duck.stagesUpserts, true);
});
