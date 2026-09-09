// End-to-end: register db-push, runAction against it, verify DB state.
// Run:  node --test test/builtins/db-push.test.js

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var fsp = require('fs/promises');
var os = require('os');
var path = require('path');
var pg = require('pg');

var actions = require('../../index');
var driver  = require('../../lib/drivers/db/postgres');
var dbPush  = require('../../lib/builtins/db/push');

var CONN = {
  host: 'localhost', port: 5435, user: 'postgres',
  password: process.env.PG_PASSWORD || 'postgres', database: 'xeplr_actions_test'
};

var pool = null;
function tempTable() { return 'test_dbpush_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }

test.before(async function() {
  var admin = new pg.Pool(Object.assign({}, CONN, { database: 'postgres', connectionTimeoutMillis: 3000 }));
  var res = await admin.query("SELECT 1 FROM pg_database WHERE datname='xeplr_actions_test'");
  if (res.rows.length === 0) await admin.query('CREATE DATABASE xeplr_actions_test');
  await admin.end();
  pool = await driver.connect(CONN);
});
test.after(async function() { if (pool) await driver.close(pool); });

test('runAction(db-push) with inline rows lands them + reports summary', async function() {
  var tbl = tempTable();

  actions.clear();
  actions.register(dbPush);

  try {
    var rows = Array.from({ length: 12 }, function(_, i) {
      return { sku: 'SKU-' + i, name: 'item ' + i, price: 10 + i, in_stock: i % 2 === 0 };
    });

    var result = await actions.runAction({
      name: 'db-push',
      input: {
        dbType:      'postgres',
        connection:  CONN,
        targetTable: tbl,
        primaryKeys: ['sku'],
        rows:        rows,
        batchSize:   5
      }
    });

    assert.strictEqual(result.status, 'success', 'runAction should succeed');
    assert.strictEqual(result.output.totalRows, 12);
    assert.strictEqual(result.output.aborted, false);
    assert.strictEqual(result.output.dropped, 0);
    assert.strictEqual(result.output.tables.main, tbl);
    assert.strictEqual(result.output.tables.errors, tbl + '_import_errors');

    var got = await pool.query('SELECT COUNT(*)::int AS c FROM ' + driver.quoteIdent(tbl));
    assert.strictEqual(got.rows[0].c, 12);
  } finally {
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('runAction(db-push) with filePath reads NDJSON and lands rows', async function() {
  var tbl = tempTable();
  var tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dbpush-'));
  var filePath = path.join(tmpDir, 'rows.ndjson');

  // Write 20 rows to NDJSON
  var lines = [];
  for (var i = 0; i < 20; i++) {
    lines.push(JSON.stringify({ id: i, label: 'row-' + i }));
  }
  await fsp.writeFile(filePath, lines.join('\n') + '\n');

  actions.clear();
  actions.register(dbPush);

  try {
    var result = await actions.runAction({
      name: 'db-push',
      input: {
        dbType:      'postgres',
        connection:  CONN,
        targetTable: tbl,
        filePath:    filePath,
        batchSize:   8
      }
    });

    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.output.totalRows, 20);

    var got = await pool.query('SELECT COUNT(*)::int AS c FROM ' + driver.quoteIdent(tbl));
    assert.strictEqual(got.rows[0].c, 20);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('runAction(db-push) validates required inputs — rejects on missing connection', async function() {
  actions.clear();
  actions.register(dbPush);
  var result = await actions.runAction({
    name: 'db-push',
    input: { targetTable: 'x', rows: [{ a: 1 }] }   // no connection
  });
  assert.strictEqual(result.status, 'failed');
  assert.ok(/connection/i.test(result.error.message), 'expected validation error mentioning connection, got: ' + result.error.message);
});

test('runAction(db-push) — shorthand call form also works', async function() {
  var tbl = tempTable();
  actions.clear();
  try {
    var result = await actions.runAction(dbPush, {
      dbType:      'postgres',
      connection:  CONN,
      targetTable: tbl,
      rows:        [{ id: 1, note: 'hello' }, { id: 2, note: 'world' }]
    });
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.output.totalRows, 2);
    var got = await pool.query('SELECT COUNT(*)::int AS c FROM ' + driver.quoteIdent(tbl));
    assert.strictEqual(got.rows[0].c, 2);
  } finally {
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});
