// Wiring test: the knex MetaStore persists movements to import_meta in a real
// xeplr_config DB while the uploader pushes data to a target DB. Proves
// recordStart/recordEnd/getLast + the empty-source and rollback paths.
//
// Requires live PG (5435) + @xeplr/db resolvable. Run:
//   node --test test/uploader/meta-store-knex.test.js

var test = require('node:test');
var assert = require('node:assert');
var knexLib = require('knex');
var { bootstrapConfigDb } = require('@xeplr/db');

var pgDriver = require('../../lib/drivers/db/postgres');
var makeKnexMetaStore = require('../../lib/uploader/meta-store-knex');
var { upload, rollback } = require('../../lib/uploader');
var { SqlQueue } = require('@xeplr/utils/lib/queue');

var PG = { host: 'localhost', port: 5435, user: 'postgres', password: 'l@rocal!Z2t9' };
var TARGET = Object.assign({}, PG, { database: 'xeplr_actions_test' });
var CONFIG_DB = 'xeplr_config_meta_test';
// Deliberately DIFFERENT strings, so a statement that filters on the wrong
// one fails the test instead of passing by coincidence — which is exactly the
// embedded case (package xeplr-workflow running as product xeplr-bi).
var SERVICE = 'xeplr-actions-test';
var APPLICATION_ID = 'xeplr-test-app';

var configKnex = null;   // handle to xeplr_config (holds import_meta)
var store = null;
var pool = null;         // target DB pool

async function* asIterable(rows) { for (var i = 0; i < rows.length; i++) yield rows[i]; }
function tempTable() { return 'meta_tgt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }

function makeQueue(name) {
  var connections = {}; connections[name] = pool;
  return new SqlQueue({
    connections: connections,
    executor: async function(item, conn) { await conn.query(item.sql, item.params || []); },
    concurrency: 4, maxAttempts: 3
  });
}

test.before(async function() {
  // Ensure target DB exists.
  var admin = knexLib({ client: 'pg', connection: Object.assign({}, PG, { database: 'postgres' }), pool: { min: 0, max: 1 } });
  var r = await admin.raw("SELECT 1 FROM pg_database WHERE datname = 'xeplr_actions_test'");
  if (!r.rows.length) await admin.raw('CREATE DATABASE xeplr_actions_test');
  await admin.raw('DROP DATABASE IF EXISTS ' + CONFIG_DB);
  await admin.destroy();

  // Bootstrap the config DB (import_meta table); skip reference-data seeds.
  var boot = await bootstrapConfigDb({ connection: PG, database: CONFIG_DB, seed: false });
  configKnex = boot.db;
  // service = the PACKAGE writing rows, applicationId = the PRODUCT owning
  // them. Both required: import_meta is shared by every app.
  store = makeKnexMetaStore(configKnex, { service: SERVICE, applicationId: APPLICATION_ID });
  pool = await pgDriver.connect(TARGET);
});

test.after(async function() {
  if (pool) await pgDriver.close(pool);
  if (configKnex) await configKnex.destroy();
  var admin = knexLib({ client: 'pg', connection: Object.assign({}, PG, { database: 'postgres' }), pool: { min: 0, max: 1 } });
  try { await admin.raw('DROP DATABASE IF EXISTS ' + CONFIG_DB); } finally { await admin.destroy(); }
});

test('getLast returns null before any movement', async function() {
  assert.strictEqual(await store.getLast({ targetTable: 'never_seen' }), null);
});

test('upload records a completed movement in import_meta', async function() {
  var tbl = tempTable();
  var q = makeQueue(tbl);
  try {
    var rows = [];
    for (var i = 0; i < 40; i++) rows.push({ id: 'K' + i, amount: i });

    var res = await upload({
      source: asIterable(rows), driver: pgDriver, connection: pool, targetTable: tbl,
      primaryKeys: ['id'], movementId: 'mv_meta_ok', queue: q, dbType: 'postgres',
      metaStore: store, batchSize: 15, firstBatchScanRows: 10
    });
    assert.strictEqual(res.totalRows, 40);

    var row = await configKnex('import_meta').where({ id: 'mv_meta_ok' }).first();
    assert.ok(row, 'import_meta row exists');
    assert.strictEqual(row.status, 'completed');
    assert.strictEqual(Number(row.total_rows), 40);
    assert.strictEqual(row.target_table, tbl);
    assert.strictEqual(row.db_type, 'postgres');
    assert.strictEqual(row.connection_key, tbl);               // defaults to targetTable
    assert.deepStrictEqual(row.primary_keys, ['id']);          // jsonb round-trips
    assert.ok(Array.isArray(row.columns) && row.columns.length === 2);
    assert.ok(row.started_at && row.ended_at);

    // getLast finds it by target table.
    var last = await store.getLast({ targetTable: tbl });
    assert.strictEqual(last.id, 'mv_meta_ok');
  } finally {
    q.stop();
    await pgDriver.query(pool, 'DROP TABLE IF EXISTS ' + pgDriver.quoteIdent(tbl + '_import_errors')).catch(function(){});
    await pgDriver.query(pool, 'DROP TABLE IF EXISTS ' + pgDriver.quoteIdent(tbl)).catch(function(){});
  }
});

test('empty source: recordEnd upserts a row even without recordStart', async function() {
  var tbl = tempTable();
  var q = makeQueue(tbl);
  try {
    var res = await upload({
      source: asIterable([]), driver: pgDriver, connection: pool, targetTable: tbl,
      movementId: 'mv_meta_empty', queue: q, dbType: 'postgres', metaStore: store,
      batchSize: 10, firstBatchScanRows: 5
    });
    assert.strictEqual(res.totalRows, 0);

    var row = await configKnex('import_meta').where({ id: 'mv_meta_empty' }).first();
    assert.ok(row, 'row created despite no recordStart (empty-source path)');
    assert.strictEqual(row.status, 'completed');
    assert.strictEqual(Number(row.total_rows), 0);
  } finally {
    q.stop();
  }
});

test('recordProgress increments counters', async function() {
  await store.recordStart('mv_prog', { targetTable: 'prog_tbl', dbType: 'postgres' });
  await store.recordProgress('mv_prog', { completed: 5, dropped: 1 });
  await store.recordProgress('mv_prog', { completed: 3 });
  var row = await configKnex('import_meta').where({ id: 'mv_prog' }).first();
  assert.strictEqual(Number(row.completed), 8);
  assert.strictEqual(Number(row.dropped), 1);
});

test('rollback recordEnd flips status and stashes delete counts', async function() {
  var tbl = tempTable();
  var q = makeQueue(tbl);
  try {
    await upload({
      source: asIterable([{ id: 'A', amount: 1 }, { id: 'B', amount: 2 }]),
      // NO primaryKeys: rollback refuses upsert movements outright (see the
      // guard in lib/uploader/index.js — an upsert cannot tell rows it
      // created from rows it merely updated, so there is no safe partial
      // undo). This test is about the META bookkeeping of a rollback, so it
      // uses the append-only movement that rollback actually supports.
      driver: pgDriver, connection: pool, targetTable: tbl,
      movementId: 'mv_meta_rb', queue: q, dbType: 'postgres', metaStore: store,
      batchSize: 10, firstBatchScanRows: 5
    });

    await rollback({
      movementId: 'mv_meta_rb', driver: pgDriver, connection: pool, targetTable: tbl,
      queue: q, metaStore: store
    });

    var row = await configKnex('import_meta').where({ id: 'mv_meta_rb' }).first();
    assert.strictEqual(row.status, 'rolled-back');
    assert.ok(row.meta && Number(row.meta.mainDeleted) === 2);
  } finally {
    q.stop();
    await pgDriver.query(pool, 'DROP TABLE IF EXISTS ' + pgDriver.quoteIdent(tbl + '_import_errors')).catch(function(){});
    await pgDriver.query(pool, 'DROP TABLE IF EXISTS ' + pgDriver.quoteIdent(tbl)).catch(function(){});
  }
});
