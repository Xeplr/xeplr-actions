// A STAGED load never touches its target until one transaction moves it in,
// at the end. So a load that stops or fails midway leaves the target exactly
// as it was, and undoing it is dropping the staging table — never a DELETE
// across the target, which on a big copy is the one thing that must not cost
// what the copy holds. All against real DuckDB files.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs'), os = require('os'), path = require('path');
var runAction = require('../lib/runner').runAction;
var dbMove = require('../lib/builtins/db/move');
var duck = require('../lib/drivers/db/duckdb');
var uploader = require('../lib/uploader');

function scratch(name) { return fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-staged-' + name + '-')); }

async function sql(file, text) {
  var pool = await duck.connect({ file: file, access: 'rw' });
  try { return (await duck.query(pool, text, [])).rows; } finally { await duck.close(pool); }
}
async function count(file, text) { return Number((await sql(file, text))[0].n); }
async function tableExists(file, name) {
  return (await count(file, "SELECT count(*) AS n FROM information_schema.tables WHERE table_name = '" + name + "'")) > 0;
}

function move(src, dst, extra) {
  return Object.assign({
    sourceDbType: 'duckdb', sourceConnection: { file: src, access: 'ro' }, mode: 'table', table: 'orders',
    targetDbType: 'duckdb', targetConnection: { file: dst, access: 'rw' }, targetTable: 'orders_copy',
    writeMode: 'append', batchSize: 1000, staged: true
  }, extra);
}

test('a staged append lands whole, leaves no staging table, and is in the ledger', async function() {
  var dir = scratch('append');
  var src = path.join(dir, 's.duckdb'), dst = path.join(dir, 'd.duckdb');
  try {
    await sql(src, 'CREATE TABLE orders AS SELECT i::BIGINT AS id, (i % 7)::INTEGER AS qty FROM range(20000) r(i)');
    var logs = [];
    var out = await runAction({ action: dbMove, system: { log: function(m) { logs.push(m); } },
      input: move(src, dst, { movementId: 'mv_append' }) });
    assert.strictEqual(out.status, 'success', JSON.stringify(out.error));
    assert.strictEqual(await count(dst, 'SELECT count(*) AS n FROM orders_copy'), 20000);
    assert.strictEqual(await tableExists(dst, 'orders_copy__xeplr_staging'), false);
    assert.ok(logs.some(function(l) { return /moved into the table in one step \(20000 in\)/.test(l); }), logs.join('\n'));
    var pool = await duck.connect({ file: dst, access: 'ro' });
    var ledger = await uploader.wasCommitted({ driver: duck, connection: pool, movementId: 'mv_append' });
    var never = await uploader.wasCommitted({ driver: duck, connection: pool, movementId: 'mv_never' });
    await duck.close(pool);
    assert.strictEqual(Number(ledger.inserted), 20000);
    assert.strictEqual(never, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a staged load stopped midway leaves the target exactly as it was', async function() {
  var dir = scratch('stop');
  var src = path.join(dir, 's.duckdb'), dst = path.join(dir, 'd.duckdb');
  try {
    await sql(src, 'CREATE TABLE orders AS SELECT i::BIGINT AS id, (i % 7)::INTEGER AS qty FROM range(200000) r(i)');
    // What the target already held, from an earlier load.
    await runAction({ action: dbMove, input: move(src, dst, { movementId: 'mv_first', table: 'orders', staged: false }) });
    var before = await count(dst, 'SELECT count(*) AS n FROM orders_copy');

    var controller = new AbortController();
    var reads = 0;
    var out = await runAction({ action: dbMove,
      system: { signal: controller.signal, onProgress: function() { reads++; if (reads === 3) controller.abort(); } },
      input: move(src, dst, { movementId: 'mv_stopped' }) });
    assert.strictEqual(out.error && out.error.code, 'STOPPED', JSON.stringify(out.error));
    assert.strictEqual(await count(dst, 'SELECT count(*) AS n FROM orders_copy'), before, 'the target is untouched');
    assert.strictEqual(await count(dst, "SELECT count(*) AS n FROM orders_copy WHERE __xeplr_movement_id__ = 'mv_stopped'"), 0);
    assert.strictEqual(await tableExists(dst, 'orders_copy__xeplr_staging'), false, 'what it wrote is gone with the staging table');
    var pool = await duck.connect({ file: dst, access: 'ro' });
    assert.strictEqual(await uploader.wasCommitted({ driver: duck, connection: pool, movementId: 'mv_stopped' }), null);
    await duck.close(pool);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a staged upsert replaces matching keys, with no index, on a table that had one', async function() {
  var dir = scratch('upsert');
  var src = path.join(dir, 's.duckdb'), dst = path.join(dir, 'd.duckdb');
  try {
    await sql(src, "CREATE TABLE orders AS SELECT i::BIGINT AS id, 'old' AS v FROM range(1000) r(i)");
    // A copy from before the rule: loaded, with the old unique index on it.
    // Made with keepIndexes, the only way to make one now.
    await runAction({ action: dbMove, input: move(src, dst, { movementId: 'mv_old', writeMode: 'upsert', primaryKeys: ['id'] }) });
    var old = await duck.connect({ file: dst, access: 'rw', keepIndexes: true });
    await duck.query(old, 'CREATE UNIQUE INDEX orders_copy_upsert_uniq ON orders_copy (id)', []);
    assert.strictEqual(Number((await duck.query(old, "SELECT count(*) AS n FROM duckdb_indexes() WHERE table_name = 'orders_copy'", [])).rows[0].n), 1);
    await duck.close(old);

    await sql(src, "DROP TABLE orders; CREATE TABLE orders AS SELECT (i + 500)::BIGINT AS id, 'new' AS v FROM range(1000) r(i)");
    var out = await runAction({ action: dbMove, input: move(src, dst, { movementId: 'mv_new', writeMode: 'upsert', primaryKeys: ['id'] }) });
    assert.strictEqual(out.status, 'success', JSON.stringify(out.error));
    assert.deepStrictEqual(out.output.merged, { inserted: 1000, replaced: 500 });
    assert.strictEqual(await count(dst, 'SELECT count(*) AS n FROM orders_copy'), 1500);
    assert.strictEqual(await count(dst, "SELECT count(*) AS n FROM orders_copy WHERE v = 'old'"), 500);
    assert.strictEqual(await count(dst, 'SELECT count(DISTINCT id) AS n FROM orders_copy'), 1500);
    assert.strictEqual(await count(dst, "SELECT count(*) AS n FROM duckdb_indexes() WHERE table_name = 'orders_copy'"), 0, 'the upsert index is gone');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the move: one row per key within a load, NULL keys kept, and all-or-nothing', async function() {
  var dir = scratch('merge');
  var file = path.join(dir, 't.duckdb');
  var pool = await duck.connect({ file: file, access: 'rw' });
  try {
    await duck.query(pool, "CREATE TABLE t (__xeplr_movement_id__ VARCHAR NOT NULL, id BIGINT, v VARCHAR)", []);
    await duck.query(pool, "INSERT INTO t VALUES ('mv0', 1, 'a'), ('mv0', 2, 'b')", []);
    // A leftover from a load that died before its move: must not leak into this one.
    await duck.query(pool, "CREATE TABLE t__xeplr_staging AS SELECT 'dead' AS __xeplr_movement_id__, 99::BIGINT AS id, 'dead' AS v", []);
    await duck.prepareStaging(pool, 't');
    assert.strictEqual(Number((await duck.query(pool, 'SELECT count(*) AS n FROM t__xeplr_staging', [])).rows[0].n), 0, 'the leftover is dropped');
    await duck.query(pool, "INSERT INTO t__xeplr_staging VALUES ('mv1', 2, 'b1'), ('mv1', 2, 'b2'), ('mv1', NULL, 'n1'), ('mv1', NULL, 'n2'), ('mv1', 3, 'c')", []);
    var cols = [{ name: 'id' }, { name: 'v' }];
    var r = await duck.mergeStaged(pool, { targetTable: 't', columns: cols, primaryKeys: ['id'], movementId: 'mv1' });
    assert.deepStrictEqual(r, { inserted: 4, replaced: 1 });
    var rows = (await duck.query(pool, 'SELECT id, v FROM t ORDER BY id NULLS LAST, v', [])).rows;
    assert.deepStrictEqual(rows.map(function(x) { return x.id + ':' + x.v; }), ['1:a', '2:b2', '3:c', 'null:n1', 'null:n2']);

    // A move that fails partway undoes itself: the upsert's DELETE with it.
    await duck.prepareStaging(pool, 't');
    await duck.query(pool, "INSERT INTO t__xeplr_staging VALUES ('mv2', 1, 'z')", []);
    await assert.rejects(duck.mergeStaged(pool, { targetTable: 't', columns: cols.concat([{ name: 'nope' }]), primaryKeys: ['id'], movementId: 'mv2' }));
    assert.strictEqual((await duck.query(pool, 'SELECT v FROM t WHERE id = 1', [])).rows[0].v, 'a', 'the delete was rolled back');
    assert.strictEqual(await duck.committedMovement(pool, 'mv2'), null);
    assert.strictEqual(Number((await duck.query(pool, 'SELECT count(*) AS n FROM t', [])).rows[0].n), 5, 'the database is still usable');
    await duck.dropStaging(pool, 't');
  } finally {
    await duck.close(pool);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a database without staged loads says so rather than writing straight in', async function() {
  var noStaging = Object.assign({}, duck, { mergeStaged: undefined });
  await assert.rejects(uploader.upload({ source: [], driver: noStaging, connection: { file: ':memory:' }, targetTable: 't',
    movementId: 'm', queue: {}, staged: true }), /staged loads are not supported/);
  await assert.rejects(uploader.wasCommitted({ driver: {}, movementId: 'm' }), /keeps no load ledger/);
  await assert.rejects(uploader.wasCommitted({}), /movementId is required/);
});

test('replaceFrom: the target\'s rows from a date on are replaced by the staged ones, in one transaction', async function() {
  var dir = scratch('window');
  var src = path.join(dir, 's.duckdb'), dst = path.join(dir, 'd.duckdb');
  try {
    // Ten days, ten rows a day, a DATE with no time — the case this is for.
    await sql(src, "CREATE TABLE orders AS SELECT i::BIGINT AS id, DATE '2026-09-21' + (i // 10)::INTEGER AS day, 'v1' AS v FROM range(100) r(i)");
    var first = await runAction({ action: dbMove, input: move(src, dst, { movementId: 'mv_w1', replaceFrom: { column: 'day' } }) });
    assert.strictEqual(first.status, 'success', JSON.stringify(first.error));
    assert.strictEqual(await count(dst, 'SELECT count(*) AS n FROM orders_copy'), 100, 'a first load deletes nothing and brings everything');

    // The source's last three days change: one row gone, every other row re-stamped.
    await sql(src, "DELETE FROM orders WHERE id = 95; UPDATE orders SET v = 'v2' WHERE day >= DATE '2026-09-28'");
    var again = await runAction({ action: dbMove, input: move(src, dst, {
      movementId: 'mv_w2', mode: 'query', table: null, sql: "SELECT * FROM orders WHERE day >= DATE '2026-09-28'",
      replaceFrom: { column: 'day' } }) });
    assert.strictEqual(again.status, 'success', JSON.stringify(again.error));
    assert.deepStrictEqual(again.output.merged, { inserted: 29, replaced: 30 });
    assert.strictEqual(await count(dst, 'SELECT count(*) AS n FROM orders_copy'), 99, 'no day duplicated, and the deleted row is gone');
    assert.strictEqual(await count(dst, "SELECT count(*) AS n FROM orders_copy WHERE day >= DATE '2026-09-28' AND v = 'v2'"), 29);
    assert.strictEqual(await count(dst, "SELECT count(*) AS n FROM orders_copy WHERE day < DATE '2026-09-28' AND v = 'v1'"), 70, 'the days before are untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('replaceFrom: a read that brought nothing deletes nothing', async function() {
  var dir = scratch('windowempty');
  var src = path.join(dir, 's.duckdb'), dst = path.join(dir, 'd.duckdb');
  try {
    await sql(src, "CREATE TABLE orders AS SELECT i::BIGINT AS id, DATE '2026-09-21' + (i // 10)::INTEGER AS day FROM range(50) r(i)");
    await runAction({ action: dbMove, input: move(src, dst, { movementId: 'mv_e1', replaceFrom: { column: 'day' } }) });
    var none = await runAction({ action: dbMove, input: move(src, dst, { movementId: 'mv_e2', mode: 'query', table: null,
      sql: "SELECT * FROM orders WHERE day >= DATE '2027-01-01'", replaceFrom: { column: 'day' } }) });
    assert.strictEqual(none.status, 'success', JSON.stringify(none.error));
    assert.strictEqual(await count(dst, 'SELECT count(*) AS n FROM orders_copy'), 50);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('replaceFrom with primaryKeys is refused: it replaces a range, not keys', async function() {
  var dir = scratch('windowkeys');
  var src = path.join(dir, 's.duckdb'), dst = path.join(dir, 'd.duckdb');
  try {
    await sql(src, "CREATE TABLE orders AS SELECT i::BIGINT AS id, DATE '2026-09-21' AS day FROM range(10) r(i)");
    var out = await runAction({ action: dbMove, input: move(src, dst, { movementId: 'mv_wk', writeMode: 'upsert', primaryKeys: ['id'], replaceFrom: { column: 'day' } }) });
    assert.strictEqual(out.status, 'failed');
    assert.match(String(out.error && out.error.message), /takes no primaryKeys/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
