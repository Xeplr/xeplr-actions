// End-to-end: CSV → file-upload action → real Postgres.
// Run:  node --test test/builtins/file-upload.test.js

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var fsp = require('fs/promises');
var os = require('os');
var path = require('path');
var pg = require('pg');

var actions   = require('../../index');
var driver    = require('../../lib/drivers/db/postgres');
var fileUpload = require('../../lib/builtins/file/upload');

var CONN = {
  host: 'localhost', port: 5435, user: 'postgres',
  password: 'l@rocal!Z2t9', database: 'xeplr_actions_test'
};
var pool = null;

function tempTable() { return 'test_csv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }

async function writeCsv(csv) {
  var dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'csvup-'));
  var file = path.join(dir, 'data.csv');
  await fsp.writeFile(file, csv);
  return { dir, file };
}

test.before(async function() {
  var admin = new pg.Pool(Object.assign({}, CONN, { database: 'postgres', connectionTimeoutMillis: 3000 }));
  var res = await admin.query("SELECT 1 FROM pg_database WHERE datname='xeplr_actions_test'");
  if (res.rows.length === 0) await admin.query('CREATE DATABASE xeplr_actions_test');
  await admin.end();
  pool = await driver.connect(CONN);
});
test.after(async function() { if (pool) await driver.close(pool); });

test('CSV → file-upload → Postgres — types inferred from header + rows', async function() {
  var tbl = tempTable();
  var { dir, file } = await writeCsv([
    'sku,name,price,in_stock',
    'SKU-001,Widget A,10.5,true',
    'SKU-002,Widget B,22.0,false',
    'SKU-003,Widget C,7.99,true'
  ].join('\n'));

  actions.clear();
  actions.register(fileUpload);

  try {
    var result = await actions.runAction({
      name: 'file-upload',
      input: {
        sourceType:  'local',
        sourcePath:  file,
        format:      'csv',
        dbType:      'postgres',
        dbConnection: CONN,
        targetTable: tbl,
        primaryKeys: ['sku']
      }
    });

    assert.strictEqual(result.status, 'success', 'runAction failed: ' + (result.error && result.error.message));
    assert.strictEqual(result.output.totalRows, 3);
    assert.strictEqual(result.output.aborted, false);

    var got = await pool.query('SELECT sku, name, price, in_stock FROM ' + driver.quoteIdent(tbl) + ' ORDER BY sku');
    assert.strictEqual(got.rows.length, 3);
    assert.strictEqual(got.rows[0].sku, 'SKU-001');
    assert.strictEqual(got.rows[0].name, 'Widget A');
    assert.strictEqual(Number(got.rows[0].price), 10.5);
    assert.strictEqual(got.rows[0].in_stock, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl + '_import_errors'));
    await pool.query('DROP TABLE IF EXISTS ' + driver.quoteIdent(tbl));
  }
});

test('actions.inferColumns is exposed and usable for pre-upload preview', async function() {
  var rows = [
    { sku: 'A', price: 10, active: true, tags: ['x'] },
    { sku: 'B', price: 20, active: false, tags: ['y', 'z'] }
  ];
  var cols = actions.inferColumns(rows);
  var byName = {};
  cols.forEach(function(c) { byName[c.name] = c.type; });
  assert.strictEqual(byName.sku,    'string');
  assert.strictEqual(byName.price,  'number');
  assert.strictEqual(byName.active, 'boolean');
  assert.strictEqual(byName.tags,   'array');
});

test('actions.uploader.inferColumns works the same way (organized namespace)', async function() {
  var cols = actions.uploader.inferColumns([{ a: 1, b: 'hi' }]);
  assert.strictEqual(cols.length, 2);
  assert.strictEqual(cols[0].name, 'a');
  assert.strictEqual(cols[0].type, 'number');
  assert.strictEqual(cols[1].name, 'b');
  assert.strictEqual(cols[1].type, 'string');
});

test('mixed-type column falls back to string (text wins)', async function() {
  var cols = actions.inferColumns([{ x: 1 }, { x: 'two' }, { x: 3 }]);
  assert.strictEqual(cols[0].type, 'string');
});
