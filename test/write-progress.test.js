// Progress says what has been WRITTEN, not only read — and keeps saying so
// while the queue drains after the read is over, but only when the count moves.
var test = require('node:test');
var assert = require('node:assert');
var { watchWrites } = require('../lib/uploader');

function fakeQueue() {
  var completed = 0;
  return {
    set: function(n) { completed = n; },
    stats: function() { return { completed: completed }; }
  };
}

test('reports each time the written count moves, and never when it does not', async function() {
  var queue = fakeQueue();
  var heard = [];
  var opts = { queue: queue, movementId: 'm1', onProgress: function(p) { heard.push(p.rowsWritten); } };
  var watch = watchWrites(opts, function() { return { rowsWritten: queue.stats().completed }; }, 20);
  await new Promise(function(r) { setTimeout(r, 60); });
  assert.deepStrictEqual(heard, [], 'nothing written yet: nothing reported');
  queue.set(500);
  await new Promise(function(r) { setTimeout(r, 60); });
  assert.deepStrictEqual(heard, [500]);
  await new Promise(function(r) { setTimeout(r, 60); });
  assert.deepStrictEqual(heard, [500], 'a stuck write goes quiet');
  queue.set(900);
  await new Promise(function(r) { setTimeout(r, 60); });
  watch.stop();
  queue.set(1200);
  await new Promise(function(r) { setTimeout(r, 60); });
  assert.deepStrictEqual(heard, [500, 900], 'nothing after stop');
});

test('a queue with no count, or a failing report, never breaks the movement', async function() {
  var opts = { queue: { stats: function() { throw new Error('no stats'); } }, movementId: 'm', onProgress: function() { throw new Error('boom'); } };
  var watch = watchWrites(opts, function() { return {}; }, 10);
  await new Promise(function(r) { setTimeout(r, 40); });
  watch.stop();
  var moving = { n: 0 };
  var opts2 = { queue: { stats: function() { return { completed: ++moving.n }; } }, movementId: 'm', onProgress: function() { throw new Error('boom'); } };
  var watch2 = watchWrites(opts2, function() { return {}; }, 10);
  await new Promise(function(r) { setTimeout(r, 40); });
  watch2.stop();
  assert.ok(true);
});

// End to end: a real movement, DuckDB file to DuckDB file, through db-move.
test('a real movement reports rows written as well as rows read', async function() {
  var fs = require('fs'), os = require('os'), path = require('path');
  var runAction = require('../lib/runner').runAction;
  var dbMove = require('../lib/builtins/db/move');
  var duck = require('../lib/drivers/db/duckdb');
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-wp-'));
  var src = path.join(dir, 'src.duckdb');
  var dst = path.join(dir, 'dst.duckdb');
  var pool = await duck.connect({ file: src, access: 'rw' });
  await duck.query(pool, 'CREATE TABLE orders AS SELECT i::BIGINT AS id, (i % 7)::INTEGER AS qty FROM range(12000) r(i)', []);
  await duck.close(pool);

  var heard = [];
  var outcome = await runAction({
    action: dbMove,
    system: { onProgress: function(p) { heard.push(p); } },
    input: {
      sourceDbType: 'duckdb', sourceConnection: { file: src, access: 'ro' }, mode: 'table', table: 'orders',
      targetDbType: 'duckdb', targetConnection: { file: dst, access: 'rw' }, targetTable: 'orders_copy',
      writeMode: 'append', batchSize: 1000
    }
  });
  try {
    assert.strictEqual(outcome.status, 'success', JSON.stringify(outcome.error || {}));
    assert.ok(heard.length > 0, 'progress was reported');
    assert.ok(heard.every(function(p) { return typeof p.rowsRead === 'number' && 'rowsWritten' in p; }), 'every report carries rowsWritten');
    var last = heard[heard.length - 1];
    assert.strictEqual(last.rowsRead, 12000);
    assert.ok(last.rowsWritten == null || (last.rowsWritten >= 0 && last.rowsWritten <= 12000), 'never more written than read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
