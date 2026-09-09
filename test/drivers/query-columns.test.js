// A query's OUTPUT COLUMNS, across all three drivers.
//
// The shape of a result is not a property of the rows in it. A SELECT that
// matched nothing still has columns, and every one of these databases says
// so — the drivers were simply discarding it, leaving callers to infer the
// shape from the first row and find nothing to infer from.
//
// Run:  node --test test/drivers/query-columns.test.js

var test = require('node:test');
var assert = require('node:assert');
var postgres = require('../../lib/drivers/db/postgres');
var mysql = require('../../lib/drivers/db/mysql');
var mssql = require('../../lib/drivers/db/mssql');

// Each fake pool answers in its own driver's native shape.
var pgPool = function(fields, rows) {
  return { query: async function() { return { rows: rows, rowCount: rows.length, fields: fields }; } };
};
var myPool = function(fields, rows) {
  return { query: async function() { return [rows, fields]; } };
};
var msPool = function(columns, rows) {
  var recordset = rows.slice();
  recordset.columns = columns;
  return { request: function() { return { input: function() {}, query: async function() { return { recordset: recordset, rowsAffected: [rows.length] }; } }; } };
};

var FIELDS = [{ name: 'coupons_id' }, { name: 'coupons_code' }, { name: 'period' }];
var MSSQL_COLUMNS = { coupons_id: { index: 0 }, coupons_code: { index: 1 }, period: { index: 2 } };
var ROW = { coupons_id: 1, coupons_code: 'X', period: '2026-07' };

test('postgres reports the query columns', async function() {
  var r = await postgres.query(pgPool(FIELDS, [ROW]));
  assert.deepStrictEqual(r.columns, ['coupons_id', 'coupons_code', 'period']);
  // The pg Result is passed through, so nothing that read it before breaks.
  assert.strictEqual(r.rows.length, 1);
});

test('mysql reports the query columns', async function() {
  var r = await mysql.query(myPool(FIELDS, [ROW]));
  assert.deepStrictEqual(r.columns, ['coupons_id', 'coupons_code', 'period']);
  assert.strictEqual(r.rowCount, 1);
});

test('mssql reports the query columns, in SELECT order', async function() {
  var r = await mssql.query(msPool(MSSQL_COLUMNS, [ROW]));
  // recordset.columns is keyed by NAME — object key order is not the SELECT's
  // order, so the driver has to sort by the index mssql provides.
  assert.deepStrictEqual(r.columns, ['coupons_id', 'coupons_code', 'period']);
});

// The whole point: this is the case that used to leave a report with no
// columns at all, because a filter narrowed the range to nothing.
test('an EMPTY result still has its columns — every driver', async function() {
  var pg = await postgres.query(pgPool(FIELDS, []));
  var my = await mysql.query(myPool(FIELDS, []));
  var ms = await mssql.query(msPool(MSSQL_COLUMNS, []));

  for (var r of [pg, my, ms]) {
    assert.strictEqual(r.rows.length, 0, 'no rows');
    assert.deepStrictEqual(r.columns, ['coupons_id', 'coupons_code', 'period'], 'columns survive');
  }
});

test('mssql out-of-order keys still sort by index', async function() {
  var r = await mssql.query(msPool({ period: { index: 2 }, coupons_id: { index: 0 }, coupons_code: { index: 1 } }, []));
  assert.deepStrictEqual(r.columns, ['coupons_id', 'coupons_code', 'period']);
});

test('a write reports no columns rather than throwing', async function() {
  // mysql2 returns a ResultSetHeader (not an array) for DML.
  var pool = { query: async function() { return [{ affectedRows: 3 }, undefined]; } };
  var r = await mysql.query(pool);
  assert.deepStrictEqual(r.columns, []);
  assert.strictEqual(r.rowCount, 3);
});

test('a driver that returns no metadata degrades to an empty list', async function() {
  var r = await postgres.query({ query: async function() { return { rows: [], rowCount: 0 }; } });
  assert.deepStrictEqual(r.columns, []);
});
