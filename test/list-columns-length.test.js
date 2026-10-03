// db-list-columns says how long each column may be (maxLength), on real
// servers — the length is what tells SQL Server's nvarchar(max) from
// nvarchar(50), which a warehouse copy leaves out by default.
//
//   XEPLR_TEST_PG_URL  postgres://user:pw@host:port/db
//   MYSQL_TEST_URL     mysql://user:pw@host:port/db
//   MSSQL_TEST_URL     mssql://user:pw@host:port/db
// A database whose URL is not set is skipped, and says so.
var test = require('node:test');
var assert = require('node:assert');
var { getDriver } = require('../lib/drivers/db');

function cfg(url) {
  var m = new URL(url);
  return { host: m.hostname, port: Number(m.port), user: decodeURIComponent(m.username), password: decodeURIComponent(m.password), database: m.pathname.slice(1) };
}

var CASES = [
  { type: 'postgres', url: process.env.XEPLR_TEST_PG_URL, ddl: 'CREATE TABLE xa_len_t (a int, b varchar(50), c text, d character(4))',
    want: { a: null, b: 50, c: null, d: 4 } },
  { type: 'mysql', url: process.env.MYSQL_TEST_URL, ddl: 'CREATE TABLE xa_len_t (a int, b varchar(50), c longtext, d char(4))',
    want: { a: null, b: 50, c: 4294967295, d: 4 } },
  { type: 'mssql', url: process.env.MSSQL_TEST_URL, ddl: 'CREATE TABLE xa_len_t (a int, b nvarchar(50), c nvarchar(max), d varbinary(max))',
    want: { a: null, b: 50, c: -1, d: -1 } }
];

CASES.forEach(function(k) {
  test(k.type + ': each column\'s maxLength', { skip: k.url ? false : 'set ' + (k.type === 'postgres' ? 'XEPLR_TEST_PG_URL' : k.type.toUpperCase() + '_TEST_URL') }, async function() {
    var driver = getDriver(k.type);
    var pool = await driver.connect(cfg(k.url));
    var drop = k.type === 'mssql' ? "IF OBJECT_ID('xa_len_t') IS NOT NULL DROP TABLE xa_len_t" : 'DROP TABLE IF EXISTS xa_len_t';
    try {
      await driver.query(pool, drop, []);
      await driver.query(pool, k.ddl, []);
      var cols = await driver.getTableSchema(pool, 'xa_len_t');
      var got = {};
      cols.forEach(function(c) { got[c.name] = c.maxLength; });
      assert.deepStrictEqual(got, k.want);
      assert.ok(cols.every(function(c) { return c.dataType && c.udtName; }), 'dataType and udtName are still there');
    } finally {
      await driver.query(pool, drop, []).catch(function() {});
      await driver.close(pool);
    }
  });
});
