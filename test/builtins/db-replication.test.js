// Cross-engine replication — proves db-fetch (streaming) → db-push end to end:
//   Postgres source  →  MySQL target   AND   Postgres source  →  MSSQL target
// plus db-fetch's inline (streaming_mode:false) path and the zero-file
// in-process pipe (upload({ source: driver.fetchStream(...) })).
//
// Requires live PG(5435) + MySQL(3306) + MSSQL(1433). Overridable via env.
// Run:  node --test test/builtins/db-replication.test.js

var test = require('node:test');
var assert = require('node:assert');
var fsp = require('fs/promises');

var pgDriver = require('../../lib/drivers/db/postgres');
var myDriver = require('../../lib/drivers/db/mysql');
var msDriver = require('../../lib/drivers/db/mssql');
var dbFetch  = require('../../lib/builtins/db/fetch');
var dbPush   = require('../../lib/builtins/db/push');
var { upload } = require('../../lib/uploader');
var { SqlQueue } = require('@xeplr/utils/lib/queue');

var PG = { host: process.env.PG_HOST || 'localhost', port: +(process.env.PG_PORT || 5435),
  user: process.env.PG_USER || 'postgres', password: process.env.PG_PASSWORD || 'postgres', database: 'xeplr_actions_test' };
var MY = { host: process.env.MYSQL_HOST || 'localhost', port: +(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD || 'break_karo', database: 'xeplr_actions_test' };
var MS = { host: process.env.MSSQL_HOST || 'localhost', port: +(process.env.MSSQL_PORT || 1433),
  user: process.env.MSSQL_USER || 'sa', password: process.env.MSSQL_PASSWORD || 'Crazypwd123!', database: 'xeplr_actions_test' };

var N = 250;
var SRC = 'repl_src_' + Math.random().toString(36).slice(2, 7);
var pgPool = null;

test.before(async function() {
  pgPool = await pgDriver.connect(PG);
  // A plain business table (NO framework columns) — the realistic replication source.
  await pgDriver.query(pgPool, 'DROP TABLE IF EXISTS ' + pgDriver.quoteIdent(SRC));
  await pgDriver.query(pgPool,
    'CREATE TABLE ' + pgDriver.quoteIdent(SRC) + ' (id TEXT, amount INTEGER, note TEXT)');
  var cols = [{ name: 'id', type: 'string' }, { name: 'amount', type: 'number' }, { name: 'note', type: 'string' }];
  var rows = [];
  for (var i = 0; i < N; i++) rows.push({ id: 'K' + String(i).padStart(4, '0'), amount: i, note: 'note-' + i });
  // Seed via a plain parameterized insert (not buildInsertSql — no movement col here).
  var vals = [], params = [], p = 1;
  rows.forEach(function(r) { vals.push('($' + (p++) + ',$' + (p++) + ',$' + (p++) + ')'); params.push(r.id, r.amount, r.note); });
  await pgDriver.query(pgPool, 'INSERT INTO ' + pgDriver.quoteIdent(SRC) + ' (id, amount, note) VALUES ' + vals.join(','), params);
});

test.after(async function() {
  if (pgPool) {
    await pgDriver.query(pgPool, 'DROP TABLE IF EXISTS ' + pgDriver.quoteIdent(SRC)).catch(function() {});
    await pgDriver.close(pgPool);
  }
});

test('db-fetch streams the PG source to an NDJSON file (default streaming)', async function() {
  var res = await dbFetch.execute({ input: { dbType: 'postgres', connection: PG, mode: 'table', table: SRC }, system: {} });
  assert.strictEqual(res.streaming, true);
  assert.strictEqual(res.format, 'jsonl');
  assert.strictEqual(res.rows, N);
  assert.ok(res.bytes > 0);
  // File really holds N NDJSON lines with the source columns.
  var text = await fsp.readFile(res.filePath, 'utf8');
  var lines = text.split('\n').filter(function(l) { return l.trim(); });
  assert.strictEqual(lines.length, N);
  var first = JSON.parse(lines[0]);
  assert.deepStrictEqual(Object.keys(first).sort(), ['amount', 'id', 'note']);
  await fsp.unlink(res.filePath).catch(function() {});
});

test('db-fetch streaming_mode:false returns inline rows', async function() {
  var res = await dbFetch.execute({ input: { dbType: 'postgres', connection: PG, mode: 'table', table: SRC, streaming_mode: false }, system: {} });
  assert.strictEqual(res.streaming, false);
  assert.strictEqual(res.rowCount, N);
  assert.strictEqual(res.rows.length, N);
});

test('replication PG → MySQL via db-fetch file → db-push', async function() {
  var tgt = 'repl_my_' + Math.random().toString(36).slice(2, 6);
  var fetched = await dbFetch.execute({ input: { dbType: 'postgres', connection: PG, mode: 'table', table: SRC }, system: {} });
  try {
    var pushed = await dbPush.execute({ input: {
      dbType: 'mysql', connection: MY, targetTable: tgt, primaryKeys: ['id'],
      filePath: fetched.filePath, movementId: 'mv_repl_my'
    }, system: {} });
    assert.strictEqual(pushed.totalRows, N);
    assert.strictEqual(pushed.aborted, false);

    var pool = await myDriver.connect(MY);
    try {
      var c = await myDriver.query(pool, 'SELECT COUNT(*) AS c FROM ' + myDriver.quoteIdent(tgt));
      assert.strictEqual(Number(c.rows[0].c), N);
      var one = await myDriver.query(pool, "SELECT id, amount, note FROM " + myDriver.quoteIdent(tgt) + " WHERE id='K0042'");
      assert.strictEqual(Number(one.rows[0].amount), 42);
      assert.strictEqual(one.rows[0].note, 'note-42');
    } finally {
      await myDriver.query(pool, 'DROP TABLE IF EXISTS ' + myDriver.quoteIdent(tgt + '_import_errors')).catch(function() {});
      await myDriver.query(pool, 'DROP TABLE IF EXISTS ' + myDriver.quoteIdent(tgt)).catch(function() {});
      await myDriver.close(pool);
    }
  } finally {
    await fsp.unlink(fetched.filePath).catch(function() {});
  }
});

test('replication PG → MSSQL via db-fetch file → db-push', async function() {
  var tgt = 'repl_ms_' + Math.random().toString(36).slice(2, 6);
  var fetched = await dbFetch.execute({ input: { dbType: 'postgres', connection: PG, mode: 'table', table: SRC }, system: {} });
  try {
    var pushed = await dbPush.execute({ input: {
      dbType: 'mssql', connection: MS, targetTable: tgt, primaryKeys: ['id'],
      filePath: fetched.filePath, movementId: 'mv_repl_ms'
    }, system: {} });
    assert.strictEqual(pushed.totalRows, N);
    assert.strictEqual(pushed.aborted, false);

    var pool = await msDriver.connect(MS);
    try {
      var c = await msDriver.query(pool, 'SELECT COUNT(*) AS c FROM ' + msDriver.quoteIdent(tgt));
      assert.strictEqual(Number(c.rows[0].c), N);
      var one = await msDriver.query(pool, "SELECT id, amount, note FROM " + msDriver.quoteIdent(tgt) + " WHERE id='K0042'");
      assert.strictEqual(Number(one.rows[0].amount), 42);
      assert.strictEqual(one.rows[0].note, 'note-42');
    } finally {
      await msDriver.query(pool, 'DROP TABLE IF EXISTS ' + msDriver.quoteIdent(tgt + '_import_errors')).catch(function() {});
      await msDriver.query(pool, 'DROP TABLE IF EXISTS ' + msDriver.quoteIdent(tgt)).catch(function() {});
      await msDriver.close(pool);
    }
  } finally {
    await fsp.unlink(fetched.filePath).catch(function() {});
  }
});

test('in-process pipe: upload({ source: pg.fetchStream(...) }) → MySQL, no intermediate file', async function() {
  var tgt = 'repl_direct_' + Math.random().toString(36).slice(2, 6);
  var myPool = await myDriver.connect(MY);
  var connections = {}; connections[tgt] = myPool;
  var q = new SqlQueue({
    connections: connections,
    executor: async function(item, conn) { await myDriver.query(conn, item.sql, item.params || []); },
    concurrency: 4, maxAttempts: 3
  });
  try {
    var source = pgDriver.fetchStream(pgPool, {
      sql: 'SELECT id, amount, note FROM ' + pgDriver.quoteIdent(SRC) + ' ORDER BY id', batchSize: 100
    });
    var res = await upload({
      source: source, driver: myDriver, connection: myPool, targetTable: tgt,
      primaryKeys: ['id'], movementId: 'mv_direct', queue: q, batchSize: 100
    });
    assert.strictEqual(res.totalRows, N);
    assert.strictEqual(res.aborted, false);

    var c = await myDriver.query(myPool, 'SELECT COUNT(*) AS c FROM ' + myDriver.quoteIdent(tgt));
    assert.strictEqual(Number(c.rows[0].c), N);
  } finally {
    q.stop();
    await myDriver.query(myPool, 'DROP TABLE IF EXISTS ' + myDriver.quoteIdent(tgt + '_import_errors')).catch(function() {});
    await myDriver.query(myPool, 'DROP TABLE IF EXISTS ' + myDriver.quoteIdent(tgt)).catch(function() {});
    await myDriver.close(myPool);
  }
});
