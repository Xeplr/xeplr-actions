// OUR BOOKKEEPING COLUMNS ARE NEVER CARRIED FROM ONE TABLE TO ANOTHER.
//
// Every table the uploader loads gets __xeplr_id__ and __xeplr_movement_id__.
// Loading such a table somewhere else — an imported file's table copied into a
// cube's warehouse, a move between databases — used to bring its columns of
// those names along, and the load then clashed with the target's own
// movement column (the bug: an Excel import could not be moved into a cube).
// They are dropped wherever the uploader works out the target's columns, so
// every path is covered: inferred from rows, or declared by the caller.
var test = require('node:test');
var assert = require('node:assert');
var duckdb = require('../lib/drivers/db/duckdb');
var { upload } = require('../lib/uploader');
var { isInternalColumn } = require('../index');
var { SqlQueue } = require('@xeplr/utils/lib/queue');

function tempTable() { return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
async function* rowsOf(list) { for (var r of list) yield r; }

async function load(pool, table, rows, opts) {
  var connections = {}; connections[table] = pool;
  var q = new SqlQueue({ connections: connections, concurrency: 1, maxAttempts: 1,
    executor: async function(item, conn) { await duckdb.query(conn, item.sql, item.params || []); } });
  try {
    return await upload(Object.assign({ source: rowsOf(rows), driver: duckdb, connection: pool,
      targetTable: table, queue: q, batchSize: 10 }, opts));
  } finally { q.stop(); }
}

async function columnsOf(pool, table) {
  return (await duckdb.getTableSchema(pool, table)).map(function(c) { return c.name; });
}

test('isInternalColumn names our bookkeeping columns, and only them', function() {
  assert.equal(isInternalColumn('__xeplr_id__'), true);
  assert.equal(isInternalColumn('__xeplr_movement_id__'), true);
  assert.equal(isInternalColumn({ name: '__xeplr_movement_id__' }), true);
  assert.equal(isInternalColumn('xeplr_movement_id'), false);
  assert.equal(isInternalColumn('movement_id'), false);
  assert.equal(isInternalColumn('amount'), false);
});

test('a loaded table loaded again elsewhere: its bookkeeping columns are left behind, the new load stamps its own', async function() {
  var pool = await duckdb.connect({ file: ':memory:', access: 'rw' });
  try {
    var imported = tempTable();
    await load(pool, imported, [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }], { movementId: 'mv-import' });
    var rows = (await duckdb.query(pool, 'SELECT * FROM ' + imported, [])).rows;
    assert.ok('__xeplr_movement_id__' in rows[0], 'the imported table carries its movement column');

    // Inferred from the rows (no columns declared) — the rows carry them.
    var copyA = tempTable();
    var a = await load(pool, copyA, rows, { movementId: 'mv-cube-a' });
    assert.equal(a.completed, 2);
    var colsA = await columnsOf(pool, copyA);
    assert.equal(colsA.filter(function(c) { return c === '__xeplr_movement_id__'; }).length, 1);
    var stampA = (await duckdb.query(pool, 'SELECT DISTINCT __xeplr_movement_id__ AS m FROM ' + copyA, [])).rows.map(function(r) { return r.m; });
    assert.deepStrictEqual(stampA, ['mv-cube-a'], 'stamped by this load, not copied from the import');

    // Declared by the caller, bookkeeping columns included — as a warehouse
    // table listing every column of its source did.
    var copyB = tempTable();
    var declared = (await duckdb.getTableSchema(pool, imported)).map(function(c) { return { name: c.name, type: duckdb.dataTypeToLogical(c.dataType) }; });
    assert.ok(declared.some(function(c) { return c.name === '__xeplr_movement_id__'; }), 'the declared columns include the bookkeeping one');
    var b = await load(pool, copyB, rows, { movementId: 'mv-cube-b', columns: declared });
    assert.equal(b.completed, 2);
    var stampB = (await duckdb.query(pool, 'SELECT DISTINCT __xeplr_movement_id__ AS m FROM ' + copyB, [])).rows.map(function(r) { return r.m; });
    assert.deepStrictEqual(stampB, ['mv-cube-b']);
    assert.deepStrictEqual((await duckdb.query(pool, 'SELECT sku, qty FROM ' + copyB + ' ORDER BY sku', [])).rows.map(function(r) { return r.sku + r.qty; }), ['A1', 'B2']);
  } finally { await duckdb.close(pool); }
});

// The bug as it happened: a file imported into Postgres (its table has
// __xeplr_id__ and __xeplr_movement_id__), then copied into a cube's DuckDB
// warehouse with every column of the source declared.
var db = require('./helpers/databases');
var pgTest = db.testWith('pg');
pgTest('an import in Postgres copied into a DuckDB warehouse: both bookkeeping columns stay behind', async function() {
  var postgres = require('../lib/drivers/db/postgres');
  var pgPool = await postgres.connect(db.config('pg', 'postgres'));
  var duck = await duckdb.connect({ file: ':memory:', access: 'rw' });
  var imported = tempTable();
  try {
    var connections = {}; connections[imported] = pgPool;
    var q = new SqlQueue({ connections: connections, concurrency: 1, maxAttempts: 1,
      executor: async function(item, conn) { await postgres.query(conn, item.sql, item.params || []); } });
    try {
      await upload({ source: rowsOf([{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }]), driver: postgres, connection: pgPool,
        targetTable: imported, queue: q, batchSize: 10, movementId: 'mv-pg-import' });
    } finally { q.stop(); }
    var schema = await postgres.getTableSchema(pgPool, imported);
    assert.ok(schema.some(function(c) { return c.name === '__xeplr_id__'; }) && schema.some(function(c) { return c.name === '__xeplr_movement_id__'; }));
    var declared = schema.map(function(c) { return { name: c.name, type: postgres.dataTypeToLogical(c.dataType) }; });
    var rows = (await postgres.query(pgPool, 'SELECT * FROM ' + imported, [])).rows;

    var replica = tempTable();
    var r = await load(duck, replica, rows, { movementId: 'mv-replica', columns: declared });
    assert.equal(r.completed, 2);
    var cols = await columnsOf(duck, replica);
    assert.equal(cols.indexOf('__xeplr_id__'), -1, 'the import\'s row ids are not copied');
    assert.equal(cols.filter(function(c) { return c === '__xeplr_movement_id__'; }).length, 1);
    assert.deepStrictEqual((await duckdb.query(duck, 'SELECT DISTINCT __xeplr_movement_id__ AS m FROM ' + replica, [])).rows.map(function(x) { return x.m; }), ['mv-replica']);
  } finally {
    await postgres.query(pgPool, 'DROP TABLE IF EXISTS ' + imported, []).catch(function() {});
    await postgres.query(pgPool, 'DROP TABLE IF EXISTS ' + imported + '_import_errors', []).catch(function() {});
    await postgres.close(pgPool);
    await duckdb.close(duck);
  }
});
