// Full uploader flow: spool-style source → SqlQueue → real Postgres.
// Run:  node --test test/uploader/upload.test.js

var test = require('node:test');
var assert = require('node:assert');
var pg = require('pg');
var driver = require('../../lib/drivers/db/postgres');
var { upload, rollback } = require('../../lib/uploader');
var { SqlQueue } = require('@xeplr/utils/lib/queue');

var CONN = {
  host: 'localhost', port: 5435, user: 'postgres',
  password: 'l@rocal!Z2t9', database: 'xeplr_actions_test'
};

var pool = null;

function tempTable() { return 'test_up_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }

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
  var admin = new pg.Pool(Object.assign({}, CONN, { database: 'postgres', connectionTimeoutMillis: 3000 }));
  var res = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", ['xeplr_actions_test']);
  if (res.rows.length === 0) await admin.query('CREATE DATABASE xeplr_actions_test');
  await admin.end();
  pool = await driver.connect(CONN);
});
test.after(async function() { if (pool) await driver.close(pool); });

test('end-to-end: infer → bootstrap → batches → drain → verify', async function() {
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
      source:       asIterable(rows),
      driver:       driver,
      connection:   pool,
      targetTable:  tbl,
      primaryKeys:  ['invoice_id'],
      movementId:   'mv_end2end_1',
      queue:        q,
      batchSize:          30,
      firstBatchScanRows: 20
    });

    assert.strictEqual(result.totalRows, 100);
    assert.ok(result.totalBatches >= 3);
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.dropped, 0);
    // Inferred columns include the ones from data (order-preserving).
    var colNames = result.columns.map(function(c) { return c.name; });
    assert.deepStrictEqual(colNames, ['invoice_id', 'amount', 'is_paid', 'meta']);

    var check = await pool.query('SELECT COUNT(*)::int AS c FROM ' + driver.quoteIdent(tbl));
    assert.strictEqual(check.rows[0].c, 100);

    var one = await pool.query('SELECT invoice_id, amount, is_paid, meta, __xeplr_movement_id__ FROM ' +
      driver.quoteIdent(tbl) + " WHERE invoice_id='INV-0007'");
    assert.strictEqual(one.rows[0].invoice_id, 'INV-0007');
    assert.strictEqual(Number(one.rows[0].amount), 17);
    assert.strictEqual(one.rows[0].is_paid, false);
    assert.deepStrictEqual(one.rows[0].meta, { batch: 0, tags: ['a', 'b'] });
    assert.strictEqual(one.rows[0].__xeplr_movement_id__, 'mv_end2end_1');
  } finally {
    q.stop();
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('rollback removes all rows for the movement', async function() {
  var tbl = tempTable();
  var q = makeQueue(tbl);

  try {
    // Upload two movements
    var m1 = Array.from({ length: 10 }, function(_, i) { return { k: 'A' + i, v: i }; });
    var m2 = Array.from({ length: 10 }, function(_, i) { return { k: 'B' + i, v: 100 + i }; });

    await upload({ source: asIterable(m1), driver: driver, connection: pool, targetTable: tbl,
      movementId: 'mv_A', queue: q, batchSize: 5, firstBatchScanRows: 5 });
    await upload({ source: asIterable(m2), driver: driver, connection: pool, targetTable: tbl,
      movementId: 'mv_B', queue: q, batchSize: 5, firstBatchScanRows: 5 });

    var before = await pool.query('SELECT COUNT(*)::int AS c FROM ' + driver.quoteIdent(tbl));
    assert.strictEqual(before.rows[0].c, 20);

    var rb = await rollback({
      movementId:  'mv_A', driver: driver, connection: pool, targetTable: tbl, queue: q
    });
    assert.strictEqual(rb.mainDeleted, 10);

    var after = await pool.query("SELECT __xeplr_movement_id__ FROM " + driver.quoteIdent(tbl) + ' ORDER BY k');
    assert.strictEqual(after.rows.length, 10);
    for (var i = 0; i < after.rows.length; i++) {
      assert.strictEqual(after.rows[i].__xeplr_movement_id__, 'mv_B');
    }
  } finally {
    q.stop();
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('pre-existing table with TEXT column: source numbers widen to strings on INSERT', async function() {
  var tbl = tempTable();
  var q = makeQueue(tbl);

  try {
    // Create the table AHEAD OF TIME with an aggressively "everything TEXT" schema.
    await pool.query(
      'CREATE TABLE ' + driver.quoteIdent(tbl) + ' (' +
      '  ' + driver.quoteIdent('__xeplr_id__') + ' BIGSERIAL PRIMARY KEY,' +
      '  ' + driver.quoteIdent('__xeplr_movement_id__') + ' TEXT,' +
      '  sku TEXT,' +
      '  age TEXT,' +           // ← would have been number if we inferred from source
      '  is_paid TEXT' +        // ← would have been boolean
      ')'
    );

    var rows = [
      { sku: 'A', age: 21, is_paid: true },
      { sku: 'B', age: 42, is_paid: false }
    ];
    var result = await upload({
      source: asIterable(rows), driver: driver, connection: pool, targetTable: tbl,
      movementId: 'mv_widen', queue: q, batchSize: 5, firstBatchScanRows: 2
    });
    assert.strictEqual(result.aborted, false);
    assert.strictEqual(result.totalRows, 2);
    // Reconciled columns should reflect target types (all string).
    var byName = {};
    result.columns.forEach(function(c) { byName[c.name] = c.type; });
    assert.strictEqual(byName.age,     'string');
    assert.strictEqual(byName.is_paid, 'string');

    // Actual values in the DB are the widened strings — not numbers/booleans.
    var got = await pool.query('SELECT sku, age, is_paid FROM ' + driver.quoteIdent(tbl) + ' ORDER BY sku');
    assert.strictEqual(got.rows[0].age,     '21');
    assert.strictEqual(got.rows[0].is_paid, 'true');
    assert.strictEqual(got.rows[1].age,     '42');
    assert.strictEqual(got.rows[1].is_paid, 'false');
  } finally {
    q.stop();
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('pre-existing table missing a source column: upload rejects with clear error', async function() {
  var tbl = tempTable();
  var q = makeQueue(tbl);

  try {
    // Table has 'sku' but not 'age'
    await pool.query(
      'CREATE TABLE ' + driver.quoteIdent(tbl) + ' (' +
      '  ' + driver.quoteIdent('__xeplr_id__') + ' BIGSERIAL PRIMARY KEY,' +
      '  ' + driver.quoteIdent('__xeplr_movement_id__') + ' TEXT,' +
      '  sku TEXT' +
      ')'
    );

    var rows = [{ sku: 'A', age: 21 }];   // 'age' isn't in target
    await assert.rejects(upload({
      source: asIterable(rows), driver: driver, connection: pool, targetTable: tbl,
      movementId: 'mv_missing', queue: q, batchSize: 5, firstBatchScanRows: 1
    }), /columns not present in target/);
  } finally {
    q.stop();
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('pre-existing INTEGER column: valid numeric-string rows land, non-numeric rows go to error table', async function() {
  var tbl = tempTable();
  var connName = tbl;
  var connections = {};
  connections[connName] = pool;

  // Custom queue for this test so we can capture onErrorTable calls
  var { SqlQueue } = require('@xeplr/utils/lib/queue');
  var errorHits = [];
  var q = new SqlQueue({
    connections: connections,
    executor: async function(item, conn) { await conn.query(item.sql, item.params || []); },
    concurrency: 1,
    maxAttempts: 1,   // fail fast → bisect quickly
    onErrorTable: function(info) { errorHits.push(info); }
  });

  try {
    // Table has INTEGER 'age' column
    await pool.query(
      'CREATE TABLE ' + driver.quoteIdent(tbl) + ' (' +
      '  ' + driver.quoteIdent('__xeplr_id__') + ' BIGSERIAL PRIMARY KEY,' +
      '  ' + driver.quoteIdent('__xeplr_movement_id__') + ' TEXT,' +
      '  age INTEGER' +
      ')'
    );

    // Source has age as strings — some numeric, some not.
    var rows = [
      { age: '21' },     // ok — coerces to 21
      { age: '42' },     // ok
      { age: 'N/A' },    // bad — PG rejects → error table
      { age: '99' }      // ok
    ];
    var result = await upload({
      source: asIterable(rows), driver: driver, connection: pool, targetTable: tbl,
      movementId: 'mv_coerce', queue: q, batchSize: 4, firstBatchScanRows: 4
    });

    assert.strictEqual(result.totalRows, 4);
    var got = await pool.query('SELECT age FROM ' + driver.quoteIdent(tbl) + ' ORDER BY age');
    assert.strictEqual(got.rows.length, 3);
    assert.strictEqual(Number(got.rows[0].age), 21);
    assert.strictEqual(Number(got.rows[1].age), 42);
    assert.strictEqual(Number(got.rows[2].age), 99);

    // The 'N/A' row hit the error-table callback with a rescue-friendly error.
    assert.strictEqual(errorHits.length, 1);
    assert.ok(/invalid input syntax/i.test(errorHits[0].error.message));
  } finally {
    q.stop();
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('wide table: batchSize clamps automatically so PG param limit is never crossed', async function() {
  var tbl = tempTable();
  var q = makeQueue(tbl);

  try {
    // 60 rows × 100 wide-ish columns. With maxParamsPerBatch=500 (test-only),
    // paramsPerRow = 100 + 1 = 101 → maxSafeBatch = floor(500 / 101) = 4.
    // The caller-requested batchSize of 50 should get clamped to 4.
    var colCount = 100;
    var rows = [];
    for (var r = 0; r < 60; r++) {
      var row = {};
      for (var c = 0; c < colCount; c++) row['col_' + c] = c * 1000 + r;
      rows.push(row);
    }

    var result = await upload({
      source: asIterable(rows), driver: driver, connection: pool, targetTable: tbl,
      movementId: 'mv_wide', queue: q,
      batchSize: 50,                    // caller asked for 50…
      maxParamsPerBatch: 500,           // …but the cap forces smaller
      firstBatchScanRows: 5
    });

    assert.strictEqual(result.totalRows, 60);
    assert.strictEqual(result.aborted, false);
    // 60 rows / 4-row batches. Spool rotates at batchSize=50, so we get
    // 2 spool files (50+10 rows). Each spool file is subdivided into
    // 4-row INSERT chunks with a remainder — so 13 (from 50) + 3 (from 10) = 16.
    // Slightly more than the theoretical minimum of 15; safe under the PG param cap.
    assert.strictEqual(result.totalBatches, 16);

    var got = await pool.query('SELECT COUNT(*)::int AS c FROM ' + driver.quoteIdent(tbl));
    assert.strictEqual(got.rows[0].c, 60);
  } finally {
    q.stop();
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('failing batch bisects down; error-table gets the failing single-row records', async function() {
  var tbl = tempTable();
  var connName = tbl;
  var connections = {};
  connections[connName] = pool;

  // Custom executor that fails when a row has k === 'BAD', bisecting will
  // eventually isolate that row.
  var q = new SqlQueue({
    connections: connections,
    executor: async function(item, conn) {
      var badRow = (item.meta.rows || []).find(function(r) { return r.k === 'BAD'; });
      if (badRow && item.meta.rows.length === 1) throw new Error('poison row');
      if (badRow) throw new Error('batch contains poison');
      await conn.query(item.sql, item.params || []);
    },
    concurrency: 1,
    maxAttempts: 1        // fail fast to force bisect
  });

  var errorInserts = [];
  q.onErrorTable = function(info) { errorInserts.push(info); };

  try {
    var rows = [
      { k: 'A', v: 1 }, { k: 'B', v: 2 }, { k: 'BAD', v: 3 }, { k: 'D', v: 4 }
    ];
    var result = await upload({
      source: asIterable(rows), driver: driver, connection: pool, targetTable: tbl,
      movementId: 'mv_poison', queue: q, batchSize: 4, firstBatchScanRows: 4
    });

    // 3 rows land, 1 gets routed to error table
    assert.strictEqual(result.totalRows, 4);
    var got = await pool.query('SELECT COUNT(*)::int AS c FROM ' + driver.quoteIdent(tbl));
    assert.strictEqual(got.rows[0].c, 3);

    // The one bad row hit onErrorTable
    assert.strictEqual(errorInserts.length, 1);
    var bad = errorInserts[0];
    assert.strictEqual(bad.item.meta.rows.length, 1);
    assert.strictEqual(bad.item.meta.rows[0].k, 'BAD');
  } finally {
    q.stop();
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});
