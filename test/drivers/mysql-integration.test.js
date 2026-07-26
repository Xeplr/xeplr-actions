// Integration test — requires a live MySQL at localhost:3306 and the mysql2
// peer dep resolvable. Auto-creates the test DB if missing.
// Run:  node --test test/drivers/mysql-integration.test.js
//
// Connection is overridable via env (MYSQL_HOST/PORT/USER/PASSWORD) so CI can
// point at its own instance; defaults match the local dev box.

var test = require('node:test');
var assert = require('node:assert');
var mysql = require('mysql2/promise');
var driver = require('../../lib/drivers/db/mysql');
var { upload, rollback } = require('../../lib/uploader');
var { SqlQueue } = require('@xeplr/utils/lib/queue');

var CONN = {
  host:     process.env.MYSQL_HOST     || 'localhost',
  port:     parseInt(process.env.MYSQL_PORT || '3306', 10),
  user:     process.env.MYSQL_USER     || 'root',
  password: process.env.MYSQL_PASSWORD || 'break_karo',
  database: 'xeplr_actions_test'
};

var pool = null;

function tempTable() {
  return 'test_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function* asIterable(rows) { for (var i = 0; i < rows.length; i++) yield rows[i]; }

function makeQueue(connName) {
  var connections = {};
  connections[connName] = pool;
  return new SqlQueue({
    connections: connections,
    executor: async function(item, conn) { await conn.query(item.sql, item.params || []); },
    concurrency: 4,
    maxAttempts: 3
  });
}

test.before(async function() {
  var admin = await mysql.createConnection({
    host: CONN.host, port: CONN.port, user: CONN.user, password: CONN.password
  });
  await admin.query('CREATE DATABASE IF NOT EXISTS ' + driver.quoteIdent(CONN.database));
  await admin.end();
  pool = await driver.connect(CONN);
});

test.after(async function() {
  if (pool) await driver.close(pool);
});

test('connect + query round-trip (normalized {rows})', async function() {
  var r = await driver.query(pool, 'SELECT 1 AS one');
  assert.strictEqual(Number(r.rows[0].one), 1);
});

test('CREATE TABLE + framework columns exist + INSERT round-trips values', async function() {
  var tbl = tempTable();
  var cols = [
    { name: 'invoice_id', type: 'string' },
    { name: 'amount',     type: 'number' },
    { name: 'issued_at',  type: 'datetime' },
    { name: 'is_paid',    type: 'boolean' },
    { name: 'meta',       type: 'object' }
  ];
  try {
    await driver.query(pool, driver.buildCreateTableSql(tbl, cols));

    var schema = await driver.getTableSchema(pool, tbl);
    var names = schema.map(function(c) { return c.name; });
    assert.deepStrictEqual(names, [
      '__xeplr_id__', '__xeplr_movement_id__',
      'invoice_id', 'amount', 'issued_at', 'is_paid', 'meta'
    ]);

    var built = driver.buildInsertSql(tbl, [
      { invoice_id: 'A1', amount: 100.5, issued_at: '2026-01-01T10:00:00Z', is_paid: false, meta: { source: 'x' } },
      { invoice_id: 'A2', amount: 200,   issued_at: '2026-01-02T11:00:00Z', is_paid: true,  meta: null }
    ], cols, 'mv_test_1', null);
    var ins = await driver.query(pool, built.sql, built.params);
    assert.strictEqual(ins.rowCount, 2);

    var got = await driver.query(pool,
      'SELECT invoice_id, amount, is_paid, meta, __xeplr_movement_id__ FROM ' +
      driver.quoteIdent(tbl) + ' ORDER BY invoice_id');
    assert.strictEqual(got.rows.length, 2);
    assert.strictEqual(got.rows[0].invoice_id, 'A1');
    assert.strictEqual(Number(got.rows[0].amount), 100.5);
    assert.strictEqual(Number(got.rows[0].is_paid), 0);          // TINYINT(1)
    // mysql2 returns JSON columns already parsed.
    var meta0 = typeof got.rows[0].meta === 'string' ? JSON.parse(got.rows[0].meta) : got.rows[0].meta;
    assert.deepStrictEqual(meta0, { source: 'x' });
    assert.strictEqual(got.rows[0].__xeplr_movement_id__, 'mv_test_1');
    assert.strictEqual(got.rows[1].meta, null);
  } finally {
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('ensureUpsertIndex is idempotent + UPSERT updates existing row', async function() {
  var tbl = tempTable();
  var cols = [
    { name: 'invoice_id', type: 'string' },
    { name: 'amount',     type: 'number' }
  ];
  try {
    await driver.query(pool, driver.buildCreateTableSql(tbl, cols));
    // Run the ensure twice — must not error the second time.
    await driver.ensureUpsertIndex(pool, tbl, ['invoice_id']);
    await driver.ensureUpsertIndex(pool, tbl, ['invoice_id']);

    var b1 = driver.buildInsertSql(tbl, [{ invoice_id: 'X', amount: 10 }], cols, 'mv1', ['invoice_id']);
    await driver.query(pool, b1.sql, b1.params);
    var b2 = driver.buildInsertSql(tbl, [{ invoice_id: 'X', amount: 25 }], cols, 'mv2', ['invoice_id']);
    await driver.query(pool, b2.sql, b2.params);

    var got = await driver.query(pool,
      'SELECT amount, __xeplr_movement_id__ FROM ' + driver.quoteIdent(tbl));
    assert.strictEqual(got.rows.length, 1);
    assert.strictEqual(Number(got.rows[0].amount), 25);
    assert.strictEqual(got.rows[0].__xeplr_movement_id__, 'mv2');   // movement updated too
  } finally {
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('ensureMovementColumn adds the column to a table that lacks it (idempotent)', async function() {
  var tbl = tempTable();
  try {
    // Create a bare table WITHOUT the movement column.
    await driver.query(pool,
      'CREATE TABLE ' + driver.quoteIdent(tbl) + ' (' +
      '  ' + driver.quoteIdent('__xeplr_id__') + ' BIGINT AUTO_INCREMENT PRIMARY KEY,' +
      '  sku VARCHAR(64))');

    await driver.ensureMovementColumn(pool, tbl);
    await driver.ensureMovementColumn(pool, tbl);   // twice — no error

    var schema = await driver.getTableSchema(pool, tbl);
    var names = schema.map(function(c) { return c.name; });
    assert.ok(names.indexOf('__xeplr_movement_id__') >= 0);
  } finally {
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('rollbackMovement deletes main + error rows for one movement only', async function() {
  var tbl = tempTable();
  var errTbl = tbl + '_import_errors';
  var cols = [{ name: 'x', type: 'string' }];
  try {
    await driver.query(pool, driver.buildCreateTableSql(tbl, cols));
    await driver.query(pool, driver.buildCreateErrorTableSql(tbl));

    var b1 = driver.buildInsertSql(tbl, [{ x: 'a' }, { x: 'b' }], cols, 'mv_target', null);
    var b2 = driver.buildInsertSql(tbl, [{ x: 'c' }, { x: 'd' }], cols, 'mv_other',  null);
    await driver.query(pool, b1.sql, b1.params);
    await driver.query(pool, b2.sql, b2.params);

    await driver.query(pool,
      'INSERT INTO ' + driver.quoteIdent(errTbl) +
      ' (movement_id, row_num, error_description, underlying_sql, raw_row) VALUES ' +
      "('mv_target', 1, 'boom', 'INSERT ...', '{}'), " +
      "('mv_target', 2, 'boom', 'INSERT ...', '{}'), " +
      "('mv_other',  1, 'boom', 'INSERT ...', '{}')");

    var result = await driver.rollbackMovement(pool, tbl, 'mv_target');
    assert.strictEqual(result.mainDeleted, 2);
    assert.strictEqual(result.errorDeleted, 2);

    var main = await driver.query(pool, 'SELECT COUNT(*) AS c FROM ' + driver.quoteIdent(tbl));
    var err  = await driver.query(pool, 'SELECT COUNT(*) AS c FROM ' + driver.quoteIdent(errTbl));
    assert.strictEqual(Number(main.rows[0].c), 2);   // mv_other survives
    assert.strictEqual(Number(err.rows[0].c),  1);
  } finally {
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(errTbl));
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('rollbackMovement is silent when error table does not exist', async function() {
  var tbl = tempTable();
  try {
    await driver.query(pool, driver.buildCreateTableSql(tbl, [{ name: 'x', type: 'string' }]));
    var result = await driver.rollbackMovement(pool, tbl, 'mv_nothing');
    assert.strictEqual(result.mainDeleted, 0);
    assert.strictEqual(result.errorDeleted, 0);
  } finally {
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('uploader end-to-end: infer → bootstrap → batches → drain → verify', async function() {
  var tbl = tempTable();
  var q = makeQueue(tbl);
  try {
    var rows = [];
    for (var i = 0; i < 100; i++) {
      rows.push({
        invoice_id: 'INV-' + String(i).padStart(4, '0'),
        amount:     10 + i,
        is_paid:    i % 3 === 0,
        meta:       { batch: Math.floor(i / 50), tags: ['a', 'b'] }
      });
    }

    var result = await upload({
      source:      asIterable(rows),
      driver:      driver,
      connection:  pool,
      targetTable: tbl,
      primaryKeys: ['invoice_id'],
      movementId:  'mv_end2end_1',
      queue:       q,
      batchSize:          30,
      firstBatchScanRows: 20
    });

    assert.strictEqual(result.totalRows, 100);
    assert.ok(result.totalBatches >= 3);
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.dropped, 0);
    assert.deepStrictEqual(result.columns.map(function(c) { return c.name; }),
      ['invoice_id', 'amount', 'is_paid', 'meta']);

    var check = await driver.query(pool, 'SELECT COUNT(*) AS c FROM ' + driver.quoteIdent(tbl));
    assert.strictEqual(Number(check.rows[0].c), 100);

    var one = await driver.query(pool,
      "SELECT invoice_id, amount, is_paid, meta, __xeplr_movement_id__ FROM " +
      driver.quoteIdent(tbl) + " WHERE invoice_id='INV-0007'");
    assert.strictEqual(one.rows[0].invoice_id, 'INV-0007');
    assert.strictEqual(Number(one.rows[0].amount), 17);
    assert.strictEqual(Number(one.rows[0].is_paid), 0);
    var meta = typeof one.rows[0].meta === 'string' ? JSON.parse(one.rows[0].meta) : one.rows[0].meta;
    assert.deepStrictEqual(meta, { batch: 0, tags: ['a', 'b'] });
    assert.strictEqual(one.rows[0].__xeplr_movement_id__, 'mv_end2end_1');
  } finally {
    q.stop();
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('uploader rollback removes all rows for the movement', async function() {
  var tbl = tempTable();
  var q = makeQueue(tbl);
  try {
    var m1 = Array.from({ length: 10 }, function(_, i) { return { k: 'A' + i, v: i }; });
    var m2 = Array.from({ length: 10 }, function(_, i) { return { k: 'B' + i, v: 100 + i }; });

    await upload({ source: asIterable(m1), driver: driver, connection: pool, targetTable: tbl,
      movementId: 'mv_A', queue: q, batchSize: 5, firstBatchScanRows: 5 });
    await upload({ source: asIterable(m2), driver: driver, connection: pool, targetTable: tbl,
      movementId: 'mv_B', queue: q, batchSize: 5, firstBatchScanRows: 5 });

    var before = await driver.query(pool, 'SELECT COUNT(*) AS c FROM ' + driver.quoteIdent(tbl));
    assert.strictEqual(Number(before.rows[0].c), 20);

    var rb = await rollback({ movementId: 'mv_A', driver: driver, connection: pool, targetTable: tbl, queue: q });
    assert.strictEqual(rb.mainDeleted, 10);

    var after = await driver.query(pool,
      'SELECT __xeplr_movement_id__ AS m FROM ' + driver.quoteIdent(tbl));
    assert.strictEqual(after.rows.length, 10);
    for (var i = 0; i < after.rows.length; i++) {
      assert.strictEqual(after.rows[i].m, 'mv_B');
    }
  } finally {
    q.stop();
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('pre-existing VARCHAR column: source numbers/booleans widen to strings', async function() {
  var tbl = tempTable();
  var q = makeQueue(tbl);
  try {
    await driver.query(pool,
      'CREATE TABLE ' + driver.quoteIdent(tbl) + ' (' +
      '  ' + driver.quoteIdent('__xeplr_id__') + ' BIGINT AUTO_INCREMENT PRIMARY KEY,' +
      '  ' + driver.quoteIdent('__xeplr_movement_id__') + ' VARCHAR(255),' +
      '  sku VARCHAR(64),' +
      '  age VARCHAR(64),' +      // would have inferred number
      '  is_paid VARCHAR(64))');  // would have inferred boolean

    var rows = [{ sku: 'A', age: 21, is_paid: true }, { sku: 'B', age: 42, is_paid: false }];
    var result = await upload({
      source: asIterable(rows), driver: driver, connection: pool, targetTable: tbl,
      movementId: 'mv_widen', queue: q, batchSize: 5, firstBatchScanRows: 2
    });
    assert.strictEqual(result.aborted, false);

    var byName = {};
    result.columns.forEach(function(c) { byName[c.name] = c.type; });
    assert.strictEqual(byName.age,     'string');   // reconciled to target (VARCHAR) type
    assert.strictEqual(byName.is_paid, 'string');

    var got = await driver.query(pool,
      'SELECT sku, age, is_paid FROM ' + driver.quoteIdent(tbl) + ' ORDER BY sku');
    assert.strictEqual(got.rows[0].age,     '21');
    assert.strictEqual(got.rows[0].is_paid, 'true');
    assert.strictEqual(got.rows[1].is_paid, 'false');
  } finally {
    q.stop();
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('pre-existing INTEGER column: numeric-string rows land, non-numeric go to error table', async function() {
  var tbl = tempTable();
  var connections = {}; connections[tbl] = pool;
  var errorHits = [];
  var q = new SqlQueue({
    connections: connections,
    executor: async function(item, conn) { await conn.query(item.sql, item.params || []); },
    concurrency: 1, maxAttempts: 1,
    onErrorTable: function(info) { errorHits.push(info); }
  });
  try {
    await driver.query(pool,
      'CREATE TABLE ' + driver.quoteIdent(tbl) + ' (' +
      '  ' + driver.quoteIdent('__xeplr_id__') + ' BIGINT AUTO_INCREMENT PRIMARY KEY,' +
      '  ' + driver.quoteIdent('__xeplr_movement_id__') + ' VARCHAR(255),' +
      '  age INT)');

    var rows = [{ age: '21' }, { age: '42' }, { age: 'N/A' }, { age: '99' }];
    var result = await upload({
      source: asIterable(rows), driver: driver, connection: pool, targetTable: tbl,
      movementId: 'mv_coerce', queue: q, batchSize: 4, firstBatchScanRows: 4
    });

    assert.strictEqual(result.totalRows, 4);
    var got = await driver.query(pool,
      'SELECT age FROM ' + driver.quoteIdent(tbl) + ' ORDER BY age');
    assert.strictEqual(got.rows.length, 3);
    assert.strictEqual(Number(got.rows[0].age), 21);
    assert.strictEqual(Number(got.rows[2].age), 99);
    assert.strictEqual(errorHits.length, 1);   // 'N/A' bisected to error table
  } finally {
    q.stop();
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});
