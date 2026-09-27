// Every DuckDB type comes out of BOTH reads (query, fetchStream) as a plain
// value that JSON.stringify accepts. A streamed read used to hand DECIMAL and
// TIMESTAMP back as DuckDB wrapper objects with a BigInt inside, and the first
// JSON.stringify downstream failed with "Do not know how to serialize a
// BigInt" — a report grouped by an amount or a date from a cube died on it.
//
//   node --test test/drivers/duckdb-values.test.js

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');

var driver = require('../../lib/drivers/db/duckdb');

var DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-duck-values-'));
var pool = null;

test.before(async function() { pool = await driver.connect({ file: path.join(DIR, 'v.duckdb'), access: 'rw' }); });
test.after(async function() {
  if (pool) await driver.close(pool);
  fs.rmSync(DIR, { recursive: true, force: true });
});

async function streamAll(sql, params) {
  var rows = [];
  for await (var row of driver.fetchStream(pool, { sql: sql, params: params || [] })) rows.push(row);
  return rows;
}

// One column of every type we know, plus a few we will never think of.
var EVERY_TYPE = [
  "true AS b",
  "7::TINYINT AS ti", "7::SMALLINT AS si", "7::INTEGER AS i", "7::BIGINT AS bi",
  "7::HUGEINT AS hi", "7::UBIGINT AS ubi", "7::UHUGEINT AS uhi",
  "1.5::FLOAT AS f", "1.5::DOUBLE AS d",
  "12.34::DECIMAL(10,2) AS dec", "123456789.123456::DECIMAL(38,6) AS dec38",
  "'x'::VARCHAR AS v",
  "DATE '2026-01-02' AS dt",
  "TIMESTAMP '2026-01-02 00:30:00' AS ts",
  "TIMESTAMPTZ '2026-01-02 00:30:00+05:30' AS tstz",
  "TIMESTAMP_NS '2026-01-02 00:30:00.123456789' AS tsns",
  "TIME '13:45:00' AS tm",
  "INTERVAL 3 DAY AS iv",
  "'8f3b4c1e-1d2a-4f5b-9c6d-7e8f9a0b1c2d'::UUID AS u",
  "'abc'::BLOB AS bl",
  "[1, 2, 3]::BIGINT[] AS lst",
  "{'a': 1::BIGINT, 'b': 'x'} AS st",
  "MAP {'k': 1::BIGINT} AS mp",
  "sum(3::BIGINT) OVER () AS total",
  "9223372036854775807::BIGINT AS huge"
].join(', ');

test('every type, from both reads, is something JSON.stringify accepts', async function() {
  var sql = 'SELECT ' + EVERY_TYPE;
  var streamed = (await streamAll(sql))[0];
  var queried = (await driver.query(pool, sql, [])).rows[0];
  for (var [label, row] of [['stream', streamed], ['query', queried]]) {
    for (var k in row) {
      assert.doesNotThrow(function() { JSON.stringify(row[k]); }, label + ' column ' + k + ' is not JSON-safe');
      assert.notStrictEqual(typeof row[k], 'bigint', label + ' column ' + k + ' is still a BigInt');
    }
  }
});

test('the streamed values are the plain values the normal read gives', async function() {
  var row = (await streamAll('SELECT ' + EVERY_TYPE))[0];
  assert.strictEqual(row.bi, 7);
  assert.strictEqual(row.hi, 7);
  assert.strictEqual(row.dec, 12.34, 'DECIMAL is a number');
  assert.strictEqual(row.dec38, 123456789.123456);
  assert.strictEqual(row.total, 3, 'SUM of BIGINT is a number');
  assert.strictEqual(row.huge, '9223372036854775807', 'too big to hold exactly: text, never rounded');
  assert.ok(row.dt instanceof Date && row.ts instanceof Date && row.tstz instanceof Date, 'dates and timestamps are Dates');
  assert.strictEqual(typeof row.tm, 'string');
  assert.strictEqual(typeof row.iv, 'string');
  assert.strictEqual(row.u, '8f3b4c1e-1d2a-4f5b-9c6d-7e8f9a0b1c2d');
  assert.strictEqual(row.v, 'x');
  assert.strictEqual(row.b, true);
  assert.deepStrictEqual(row.lst, [1, 2, 3], 'a list is an array, as the normal read gives it');
  assert.deepStrictEqual(row.st, { a: 1, b: 'x' });
});

test('lists and structs come out the same from both reads', async function() {
  var sql = "SELECT [1, 2]::BIGINT[] AS lst, {'a': 1::BIGINT, 'b': 'x'} AS st";
  var streamed = (await streamAll(sql))[0];
  var queried = (await driver.query(pool, sql, [])).rows[0];
  assert.deepStrictEqual(streamed, queried);
});

test('time zones: a timestamp without one is UTC, one with a zone keeps its instant', async function() {
  var row = (await streamAll('SELECT ' + EVERY_TYPE))[0];
  assert.strictEqual(row.dt.toISOString(), '2026-01-02T00:00:00.000Z', 'a date is its UTC midnight');
  assert.strictEqual(row.ts.toISOString(), '2026-01-02T00:30:00.000Z', 'wall-clock 00:30 read as UTC, not shifted');
  assert.strictEqual(row.tstz.toISOString(), '2026-01-01T19:00:00.000Z', '00:30 at +05:30 is 19:00 UTC the day before');
  assert.strictEqual(row.tsns.toISOString(), '2026-01-02T00:30:00.123Z');
});

test('a query that needs no conversion runs exactly as given', async function() {
  var rows = await streamAll('SELECT 1::INTEGER AS a, \'x\' AS b, 2::BIGINT AS c');
  assert.deepStrictEqual(rows, [{ a: 1, b: 'x', c: 2 }]);
});

test('wrapping keeps params, a trailing semicolon and two columns of one name', async function() {
  var rows = await streamAll('SELECT $1::DECIMAL(10,2) AS amount, 2.5::DECIMAL(4,1) AS amount2, TIMESTAMP \'2026-03-01\' AS ts ;', [4.25]);
  assert.deepStrictEqual(rows.map(function(r) { return [r.amount, r.amount2, r.ts.toISOString()]; }),
    [[4.25, 2.5, '2026-03-01T00:00:00.000Z']]);
  var same = await streamAll('SELECT t1.x, t2.x FROM (SELECT 1.5::DECIMAL(3,1) AS x) t1, (SELECT 2 AS x) t2');
  assert.strictEqual(same.length, 1, 'a duplicate name does not break the wrap');
});

test('nulls stay null through every conversion', async function() {
  var row = (await streamAll('SELECT NULL::DECIMAL(10,2) AS a, NULL::TIMESTAMP AS b, NULL::TIMESTAMPTZ AS c, NULL::INTERVAL AS d, NULL::BIGINT AS e'))[0];
  assert.deepStrictEqual(row, { a: null, b: null, c: null, d: null, e: null });
});

test('a large streamed read of converted columns stays streamed', async function() {
  var n = 0;
  var last = null;
  for await (var row of driver.fetchStream(pool, { sql: "SELECT i::BIGINT AS id, (i % 100)::DECIMAL(6,2) AS amount, TIMESTAMP '2024-01-01' + to_seconds(i) AS ts FROM range(200000) r(i)", params: [] })) {
    n++; last = row;
  }
  assert.strictEqual(n, 200000);
  assert.strictEqual(typeof last.amount, 'number');
  assert.ok(last.ts instanceof Date);
});
