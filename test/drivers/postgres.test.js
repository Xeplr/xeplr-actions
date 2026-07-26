// Integration test — requires a live Postgres at localhost:5435 and the
// pg peer dep resolvable. Auto-creates the test DB if missing.
// Run:  node --test test/drivers/postgres.test.js

var test = require('node:test');
var assert = require('node:assert');
var pg = require('pg');
var driver = require('../../lib/drivers/db/postgres');

var CONN = {
  host:     'localhost',
  port:     5435,
  user:     'postgres',
  password: 'l@rocal!Z2t9',
  database: 'xeplr_actions_test'
};

var pool = null;

// A unique table suffix per run so parallel/re-runs don't collide.
function tempTable() {
  return 'test_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

test.before(async function() {
  // Ensure the test DB exists — connect to 'postgres' first
  var admin = new pg.Pool(Object.assign({}, CONN, { database: 'postgres', connectionTimeoutMillis: 3000 }));
  var res = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", ['xeplr_actions_test']);
  if (res.rows.length === 0) {
    await admin.query('CREATE DATABASE xeplr_actions_test');
  }
  await admin.end();
  pool = await driver.connect(CONN);
});

test.after(async function() {
  if (pool) await driver.close(pool);
});

test('connect + query round-trip', async function() {
  var r = await driver.query(pool, 'SELECT 1 AS one');
  assert.strictEqual(r.rows[0].one, 1);
});

test('CREATE TABLE + framework columns exist + INSERT', async function() {
  var tbl = tempTable();
  try {
    await driver.query(pool, driver.buildCreateTableSql(tbl, [
      { name: 'invoice_id', type: 'string' },
      { name: 'amount',     type: 'number' },
      { name: 'issued_at',  type: 'datetime' },
      { name: 'is_paid',    type: 'boolean' },
      { name: 'meta',       type: 'object' }
    ]));

    // Framework columns present?
    var cols = await driver.query(pool,
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
      [tbl]);
    var names = cols.rows.map(function(r) { return r.column_name; });
    assert.deepStrictEqual(names, [
      '__xeplr_id__', '__xeplr_movement_id__',
      'invoice_id', 'amount', 'issued_at', 'is_paid', 'meta'
    ]);

    // Insert two rows via buildInsertSql
    var built = driver.buildInsertSql(tbl, [
      { invoice_id: 'A1', amount: 100.5, issued_at: '2026-01-01T10:00:00Z', is_paid: false, meta: { source: 'x' } },
      { invoice_id: 'A2', amount: 200,   issued_at: '2026-01-02T11:00:00Z', is_paid: true,  meta: null }
    ], [
      { name: 'invoice_id', type: 'string' },
      { name: 'amount',     type: 'number' },
      { name: 'issued_at',  type: 'datetime' },
      { name: 'is_paid',    type: 'boolean' },
      { name: 'meta',       type: 'object' }
    ], 'mv_test_1', null);
    var ins = await driver.query(pool, built.sql, built.params);
    assert.strictEqual(ins.rowCount, 2);

    var got = await driver.query(pool, 'SELECT invoice_id, amount, is_paid, meta, __xeplr_movement_id__ FROM ' + driver.quoteIdent(tbl) + ' ORDER BY invoice_id');
    assert.strictEqual(got.rows.length, 2);
    assert.strictEqual(got.rows[0].invoice_id, 'A1');
    assert.strictEqual(Number(got.rows[0].amount), 100.5);       // NUMERIC returned as string sometimes
    assert.strictEqual(got.rows[0].is_paid, false);
    assert.deepStrictEqual(got.rows[0].meta, { source: 'x' });
    assert.strictEqual(got.rows[0].__xeplr_movement_id__, 'mv_test_1');
    assert.strictEqual(got.rows[1].meta, null);
  } finally {
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('UPSERT: re-inserting same primaryKey updates existing row', async function() {
  var tbl = tempTable();
  try {
    await driver.query(pool, driver.buildCreateTableSql(tbl, [
      { name: 'invoice_id', type: 'string' },
      { name: 'amount',     type: 'number' }
    ]));
    // The UNIQUE index enables ON CONFLICT
    await driver.query(pool, driver.buildUpsertIndexSql(tbl, ['invoice_id']));

    var cols = [
      { name: 'invoice_id', type: 'string' },
      { name: 'amount',     type: 'number' }
    ];

    // First insert
    var b1 = driver.buildInsertSql(tbl, [{ invoice_id: 'X', amount: 10 }], cols, 'mv1', ['invoice_id']);
    await driver.query(pool, b1.sql, b1.params);

    // Second insert with different amount — should UPDATE not INSERT
    var b2 = driver.buildInsertSql(tbl, [{ invoice_id: 'X', amount: 25 }], cols, 'mv2', ['invoice_id']);
    await driver.query(pool, b2.sql, b2.params);

    var got = await driver.query(pool, 'SELECT amount, __xeplr_movement_id__ FROM ' + driver.quoteIdent(tbl));
    assert.strictEqual(got.rows.length, 1);
    assert.strictEqual(Number(got.rows[0].amount), 25);
    // Movement id also updated by EXCLUDED, so belongs to mv2 now
    assert.strictEqual(got.rows[0].__xeplr_movement_id__, 'mv2');
  } finally {
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('ALTER TABLE ADD is idempotent + adds new columns', async function() {
  var tbl = tempTable();
  try {
    await driver.query(pool, driver.buildCreateTableSql(tbl, [{ name: 'a', type: 'string' }]));
    // Running the add twice should not error
    var stmts = driver.buildAlterTableAddSql(tbl, [
      { name: 'b', type: 'number' },
      { name: 'c', type: 'boolean' }
    ]);
    for (var i = 0; i < stmts.length; i++) await driver.query(pool, stmts[i]);
    for (var j = 0; j < stmts.length; j++) await driver.query(pool, stmts[j]);   // twice — no error

    var cols = await driver.query(pool,
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1", [tbl]);
    var names = cols.rows.map(function(r) { return r.column_name; }).sort();
    assert.ok(names.indexOf('b') >= 0);
    assert.ok(names.indexOf('c') >= 0);
  } finally {
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('rollbackMovement deletes main + error tables for movementId', async function() {
  var tbl = tempTable();
  var errTbl = tbl + '_import_errors';
  try {
    await driver.query(pool, driver.buildCreateTableSql(tbl,     [{ name: 'x', type: 'string' }]));
    await driver.query(pool, driver.buildCreateErrorTableSql(tbl));

    // Two movements interleaved
    var cols = [{ name: 'x', type: 'string' }];
    var b1 = driver.buildInsertSql(tbl, [{ x: 'a' }, { x: 'b' }], cols, 'mv_target', null);
    var b2 = driver.buildInsertSql(tbl, [{ x: 'c' }, { x: 'd' }], cols, 'mv_other',  null);
    await driver.query(pool, b1.sql, b1.params);
    await driver.query(pool, b2.sql, b2.params);

    await driver.query(pool,
      'INSERT INTO ' + driver.quoteIdent(errTbl) +
      ' (movement_id, row_num, error_description, underlying_sql, raw_row) VALUES ' +
      "('mv_target', 1, 'boom', 'INSERT ...', '{}'::jsonb), " +
      "('mv_target', 2, 'boom', 'INSERT ...', '{}'::jsonb), " +
      "('mv_other',  1, 'boom', 'INSERT ...', '{}'::jsonb)");

    var result = await driver.rollbackMovement(pool, tbl, 'mv_target');
    assert.strictEqual(result.mainDeleted, 2);
    assert.strictEqual(result.errorDeleted, 2);

    var main = await driver.query(pool, 'SELECT COUNT(*)::int AS c FROM ' + driver.quoteIdent(tbl));
    var err  = await driver.query(pool, 'SELECT COUNT(*)::int AS c FROM ' + driver.quoteIdent(errTbl));
    assert.strictEqual(main.rows[0].c, 2);   // mv_other survives
    assert.strictEqual(err.rows[0].c,  1);
  } finally {
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(errTbl));
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('rollbackMovement is silent when error table doesn\'t exist', async function() {
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
