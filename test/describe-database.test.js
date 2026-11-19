// db-describe: a whole database's structure from its catalogue, on real
// servers — tables with their schema, columns, types, primary key and
// comments, and the foreign keys between them. What a schema digest is built
// from.
//
// Each database gets two tables, xa_ds_customers and xa_ds_orders (orders →
// customers), with a table comment and a column comment written the way that
// database writes them. DuckDB always runs; the servers run when their *_HOST
// is set (test/helpers/databases.js).
var assert = require('node:assert');
var fs = require('fs'), os = require('os'), path = require('path');
var nodeTest = require('node:test');
var db = require('./helpers/databases');
var { getDriver } = require('../lib/drivers/db');
var builtins = require('../lib/builtins');

var CREATE = [
  'CREATE TABLE xa_ds_customers (id int PRIMARY KEY, name varchar(40) NOT NULL)',
  'CREATE TABLE xa_ds_orders (id int PRIMARY KEY, customer_id int REFERENCES xa_ds_customers(id), total decimal(10,2))'
];
var COMMENT_ON = [
  "COMMENT ON TABLE xa_ds_orders IS 'Orders placed'",
  "COMMENT ON COLUMN xa_ds_orders.total IS 'Order total after discount'"
];
var DROP = ['xa_ds_orders', 'xa_ds_customers'];

var SERVERS = [
  { kind: 'pg', type: 'postgres', database: 'postgres', schema: 'public', create: CREATE.concat(COMMENT_ON),
    drop: function(t) { return 'DROP TABLE IF EXISTS ' + t; } },
  { kind: 'mysql', type: 'mysql', database: 'xeplr_actions_test', schema: 'xeplr_actions_test',
    create: [CREATE[0],
      "CREATE TABLE xa_ds_orders (id int PRIMARY KEY, customer_id int, total decimal(10,2) COMMENT 'Order total after discount', " +
      "FOREIGN KEY (customer_id) REFERENCES xa_ds_customers(id)) COMMENT='Orders placed'"],
    drop: function(t) { return 'DROP TABLE IF EXISTS ' + t; } },
  { kind: 'mssql', type: 'mssql', database: 'master', schema: 'dbo',
    create: CREATE.concat([
      "EXEC sp_addextendedproperty 'MS_Description', 'Orders placed', 'SCHEMA', 'dbo', 'TABLE', 'xa_ds_orders'",
      "EXEC sp_addextendedproperty 'MS_Description', 'Order total after discount', 'SCHEMA', 'dbo', 'TABLE', 'xa_ds_orders', 'COLUMN', 'total'"]),
    drop: function(t) { return "IF OBJECT_ID('" + t + "') IS NOT NULL DROP TABLE " + t; } }
];

/** The two tables made here, and the key between them — a shared test database may hold others. */
function ours(out) {
  var tables = out.tables.filter(function(t) { return /^xa_ds_/.test(t.name); })
    .sort(function(a, b) { return a.name < b.name ? -1 : 1; });
  var keys = out.foreignKeys.filter(function(k) { return /^xa_ds_/.test(k.table); });
  return { tables: tables, keys: keys };
}

function checkShape(out, schema) {
  var got = ours(out);
  assert.deepStrictEqual(got.tables.map(function(t) { return t.name; }), ['xa_ds_customers', 'xa_ds_orders']);
  var customers = got.tables[0], orders = got.tables[1];
  assert.ok(got.tables.every(function(t) { return t.schema === schema; }), 'each table carries its schema');
  assert.deepStrictEqual(orders.columns.map(function(c) { return c.name; }), ['id', 'customer_id', 'total'], 'columns in table order');
  assert.strictEqual(orders.description, 'Orders placed');
  assert.strictEqual(customers.description, null, 'no comment is null');
  var total = orders.columns[2];
  assert.strictEqual(total.description, 'Order total after discount');
  assert.match(total.dataType.toLowerCase(), /^(decimal|numeric)/);
  assert.strictEqual(total.nullable, true);
  assert.strictEqual(orders.columns[0].primaryKey, true);
  assert.strictEqual(orders.columns[1].primaryKey, false);
  assert.strictEqual(customers.columns[1].nullable, false);
  assert.strictEqual(customers.columns[1].description, null);
  assert.strictEqual(got.keys.length, 1);
  var k = got.keys[0];
  assert.deepStrictEqual(
    { schema: k.schema, table: k.table, columns: k.columns, refSchema: k.refSchema, refTable: k.refTable, refColumns: k.refColumns },
    { schema: schema, table: 'xa_ds_orders', columns: ['customer_id'], refSchema: schema, refTable: 'xa_ds_customers', refColumns: ['id'] });
  assert.ok(k.name, 'the key has a name');
}

SERVERS.forEach(function(s) {
  var test = db.testWith(s.kind);
  test(s.type + ': every table with its columns, keys and comments', async function() {
    var driver = getDriver(s.type);
    var conn = db.config(s.kind, s.database);
    var pool = await driver.connect(conn);
    try {
      for (var t of DROP) await driver.query(pool, s.drop(t), []);
      for (var sql of s.create) await driver.query(pool, sql, []);
      checkShape(await driver.describeDatabase(pool), s.schema);
      checkShape(await driver.describeDatabase(pool, s.schema), s.schema);
      var other = await driver.describeDatabase(pool, 'xa_no_such_schema');
      assert.deepStrictEqual(other, { tables: [], foreignKeys: [] }, 'one schema only when asked');
      // Through the action, as an app asks for it.
      checkShape(await builtins.dbDescribe.execute({ input: { dbType: s.type, connection: conn } }), s.schema);
    } finally {
      for (var d of DROP) await driver.query(pool, s.drop(d), []).catch(function() {});
      await driver.close(pool);
    }
  });
});

nodeTest('duckdb: every table with its columns, keys and comments', async function() {
  var duck = getDriver('duckdb');
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xa-ds-'));
  var file = path.join(dir, 'ds.duckdb');
  try {
    var pool = await duck.connect({ file: file, access: 'rw' });
    try {
      for (var sql of CREATE.concat(COMMENT_ON)) await duck.query(pool, sql, []);
      checkShape(await duck.describeDatabase(pool), 'main');
      checkShape(await duck.describeDatabase(pool, 'main'), 'main');
    } finally {
      await duck.close(pool);
    }
    checkShape(await builtins.dbDescribe.execute({ input: { dbType: 'duckdb', connection: { file: file } } }), 'main');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

nodeTest('a driver without describeDatabase is refused by name', async function() {
  await assert.rejects(
    builtins.dbDescribe.execute({ input: { dbType: 'mongo', connection: {} } }),
    /describeDatabase|mongo/);
});
