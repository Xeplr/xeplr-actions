// db-list-foreign-keys: the joins a database already declares, on real
// servers — what the BI dataset canvas joins two tables on without asking.
//
// Each database gets the same three tables: orders → customers on one column,
// and order_lines → orders on a COMPOSITE key, so the key's column order is
// checked too. A key into another schema is left out (listTables would not
// list its table). DuckDB always runs; the servers run when their *_HOST is
// set (test/helpers/databases.js).
var assert = require('node:assert');
var fs = require('fs'), os = require('os'), path = require('path');
var nodeTest = require('node:test');
var db = require('./helpers/databases');
var { getDriver } = require('../lib/drivers/db');
var builtins = require('../lib/builtins');

var WANT = [
  { table: 'xa_fk_lines', columns: ['order_id', 'region'], refTable: 'xa_fk_orders', refColumns: ['id', 'region'] },
  { table: 'xa_fk_orders', columns: ['customer_id'], refTable: 'xa_fk_customers', refColumns: ['id'] }
];

// Only the three tables made here — a shared test database may hold others.
function ours(fks) {
  return fks.filter(function(fk) { return /^xa_fk_/.test(fk.table); })
    .map(function(fk) { return { table: fk.table, columns: fk.columns, refTable: fk.refTable, refColumns: fk.refColumns }; })
    .sort(function(a, b) { return a.table < b.table ? -1 : 1; });
}

var DDL = [
  'CREATE TABLE xa_fk_customers (id int PRIMARY KEY, name varchar(40))',
  'CREATE TABLE xa_fk_orders (id int, region varchar(10), customer_id int REFERENCES xa_fk_customers(id), PRIMARY KEY (id, region))',
  'CREATE TABLE xa_fk_lines (line int PRIMARY KEY, order_id int, region varchar(10), ' +
    'FOREIGN KEY (order_id, region) REFERENCES xa_fk_orders(id, region))'
];
var DROP = ['xa_fk_lines', 'xa_fk_orders', 'xa_fk_customers'];

var SERVERS = [
  { kind: 'pg', type: 'postgres', database: 'postgres', drop: function(t) { return 'DROP TABLE IF EXISTS ' + t; } },
  { kind: 'mysql', type: 'mysql', database: 'xeplr_actions_test', drop: function(t) { return 'DROP TABLE IF EXISTS ' + t; } },
  { kind: 'mssql', type: 'mssql', database: 'master', drop: function(t) { return "IF OBJECT_ID('" + t + "') IS NOT NULL DROP TABLE " + t; } }
];

SERVERS.forEach(function(s) {
  var test = db.testWith(s.kind);
  test(s.type + ': foreign keys, composite ones in key order', async function() {
    var driver = getDriver(s.type);
    var conn = db.config(s.kind, s.database);
    var pool = await driver.connect(conn);
    try {
      for (var t of DROP) await driver.query(pool, s.drop(t), []);
      for (var sql of DDL) await driver.query(pool, sql, []);
      assert.deepStrictEqual(ours(await driver.listForeignKeys(pool)), WANT);
      var named = (await driver.listForeignKeys(pool)).filter(function(fk) { return /^xa_fk_/.test(fk.table); });
      assert.ok(named.every(function(fk) { return fk.name; }), 'every key has its constraint name');
      // Through the action, as an app asks for it.
      var out = await builtins.dbListForeignKeys.execute({ input: { dbType: s.type, connection: conn } });
      assert.deepStrictEqual(ours(out.foreignKeys), WANT);
    } finally {
      for (var d of DROP) await driver.query(pool, s.drop(d), []).catch(function() {});
      await driver.close(pool);
    }
  });
});

nodeTest('duckdb: foreign keys, composite ones in key order', async function() {
  var duck = getDriver('duckdb');
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xa-fk-'));
  var file = path.join(dir, 'fk.duckdb');
  try {
    var pool = await duck.connect({ file: file, access: 'rw' });
    try {
      for (var sql of DDL) await duck.query(pool, sql, []);
      assert.deepStrictEqual(ours(await duck.listForeignKeys(pool)), WANT);
    } finally {
      await duck.close(pool);
    }
    var out = await builtins.dbListForeignKeys.execute({ input: { dbType: 'duckdb', connection: { file: file } } });
    assert.deepStrictEqual(ours(out.foreignKeys), WANT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

nodeTest('a driver without foreign keys says so', async function() {
  await assert.rejects(
    builtins.dbListForeignKeys.execute({ input: { dbType: 'mongo', connection: {} } }),
    /does not (implement|support)|not available|mongo/i
  );
});
