// A running movement can be STOPPED on request: the read stops, the queued
// writes are dropped, and it ends saying so (code STOPPED), not as a failure
// and not as a success. What it wrote stays, under its movement id.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs'), os = require('os'), path = require('path');
var runAction = require('../lib/runner').runAction;
var dbMove = require('../lib/builtins/db/move');
var duck = require('../lib/drivers/db/duckdb');
var { stoppedError } = require('../lib/uploader');

test('stoppedError carries its code', function() {
  var e = stoppedError();
  assert.strictEqual(e.code, 'STOPPED');
  assert.match(e.message, /Stopped/);
});

test('stopping a movement midway ends it as STOPPED, with part of it written', async function() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-stop-'));
  var src = path.join(dir, 'src.duckdb');
  var dst = path.join(dir, 'dst.duckdb');
  var pool = await duck.connect({ file: src, access: 'rw' });
  await duck.query(pool, 'CREATE TABLE orders AS SELECT i::BIGINT AS id, (i % 7)::INTEGER AS qty FROM range(200000) r(i)', []);
  await duck.close(pool);

  var controller = new AbortController();
  var reads = 0;
  var outcome = await runAction({
    action: dbMove,
    system: {
      signal: controller.signal,
      onProgress: function() { reads++; if (reads === 3) controller.abort(); }
    },
    input: {
      sourceDbType: 'duckdb', sourceConnection: { file: src, access: 'ro' }, mode: 'table', table: 'orders',
      targetDbType: 'duckdb', targetConnection: { file: dst, access: 'rw' }, targetTable: 'orders_copy',
      writeMode: 'append', batchSize: 1000, movementId: 'mv_stop_test'
    }
  });
  try {
    assert.strictEqual(outcome.status, 'failed');
    assert.strictEqual(outcome.error && outcome.error.code, 'STOPPED', JSON.stringify(outcome.error));
    assert.ok(reads < 200, 'the read stopped early, not after all 200 batches (' + reads + ')');
    var out = await duck.connect({ file: dst, access: 'ro' });
    var n = Number((await duck.query(out, 'SELECT count(*) AS n FROM orders_copy', []).catch(function() { return { rows: [{ n: 0 }] }; })).rows[0].n);
    var tagged = Number((await duck.query(out, "SELECT count(*) AS n FROM orders_copy WHERE __xeplr_movement_id__ = 'mv_stop_test'", []).catch(function() { return { rows: [{ n: 0 }] }; })).rows[0].n);
    await duck.close(out);
    assert.ok(n < 200000, 'not everything was written (' + n + ')');
    assert.strictEqual(tagged, n, 'what was written carries the movement id, so it can be rolled back');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a signal already stopped starts nothing', async function() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-stop0-'));
  var src = path.join(dir, 's.duckdb');
  var pool = await duck.connect({ file: src, access: 'rw' });
  await duck.query(pool, 'CREATE TABLE t AS SELECT 1 AS id', []);
  await duck.close(pool);
  var controller = new AbortController();
  controller.abort();
  var outcome = await runAction({
    action: dbMove,
    system: { signal: controller.signal },
    input: {
      sourceDbType: 'duckdb', sourceConnection: { file: src, access: 'ro' }, mode: 'table', table: 't',
      targetDbType: 'duckdb', targetConnection: { file: path.join(dir, 'd.duckdb'), access: 'rw' }, targetTable: 't2', writeMode: 'append'
    }
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(outcome.error && outcome.error.code, 'STOPPED');
});
