// Rows the database refuses are kept in <table>_import_errors — not just
// counted. Real DuckDB (in memory), the real uploader and the real SqlQueue.
// Run:  node --test test/import-error-rows.test.js

var test = require('node:test');
var assert = require('node:assert');
var duckdb = require('../lib/drivers/db/duckdb');
var { upload } = require('../lib/uploader');
var { SqlQueue } = require('@xeplr/utils/lib/queue');

function tempTable() { return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

async function* rowsOf(list) { for (var r of list) yield r; }

// 10 rows into a table that refuses a negative qty: row 4 and row 9 fail.
function sample() {
  var rows = [];
  for (var i = 1; i <= 10; i++) rows.push({ sku: 'S' + i, qty: i === 4 || i === 9 ? -1 : i });
  return rows;
}

async function load(opts) {
  var t = tempTable();
  var pool = await duckdb.connect({ file: ':memory:', access: 'rw' });
  var connections = {}; connections[t] = pool;
  var q = new SqlQueue(Object.assign({ connections: connections, concurrency: 1, maxAttempts: 1,
    executor: async function(item, conn) { await duckdb.query(conn, item.sql, item.params || []); } }, opts.queue || {}));
  await duckdb.query(pool, 'CREATE TABLE ' + duckdb.quoteIdent(t) + ' (sku VARCHAR, qty INTEGER CHECK (qty >= 0))');
  if (opts.before) await opts.before(pool, t);
  try {
    var result = await upload({ source: rowsOf(sample()), driver: opts.driver || duckdb, connection: pool,
      targetTable: t, movementId: 'mv-1', queue: q, batchSize: 10 });
    var errs = [];
    try {
      errs = (await duckdb.query(pool, 'SELECT movement_id, row_num, error_description, underlying_sql, raw_row FROM ' +
        duckdb.quoteIdent(t + '_import_errors') + ' ORDER BY row_num')).rows;
    } catch (_) { /* no error table */ }
    return { result: result, errs: errs, queue: q };
  } finally {
    q.stop();
    await duckdb.close(pool);
  }
}

function raw(r) { return typeof r.raw_row === 'string' ? JSON.parse(r.raw_row) : r.raw_row; }

test('each refused row is recorded: its place in the source, the reason, the statement and the row', async function() {
  var { result, errs } = await load({});
  assert.equal(result.completed, 8);
  assert.equal(result.dropped, 2);
  assert.deepEqual(result.errorRows, { recorded: 2, notRecorded: 0 });
  assert.deepEqual(errs.map(function(e) { return e.row_num; }), [4, 9]);
  assert.deepEqual(errs.map(raw), [{ sku: 'S4', qty: -1 }, { sku: 'S9', qty: -1 }]);
  assert.equal(errs[0].movement_id, 'mv-1');
  assert.match(errs[0].error_description, /constraint/i);
  assert.match(errs[0].underlying_sql, /^INSERT INTO/);   // one row per statement once split down
});

test('the queue\'s own onErrorTable hook still runs, and is put back afterwards', async function() {
  var heard = [];
  var hook = function(info) { heard.push(info.item.meta.rows.length); };
  var { result, errs, queue } = await load({ queue: { onErrorTable: hook } });
  assert.equal(heard.length, 2);
  assert.equal(errs.length, 2);
  assert.equal(result.errorRows.recorded, 2);
  assert.equal(queue.onErrorTable, hook);
});

test('a failure to record is counted with its reason, and never fails the load', async function() {
  // An error table that exists already and will not take these rows.
  var { result, errs } = await load({ before: async function(pool, t) {
    await duckdb.query(pool, 'CREATE TABLE ' + duckdb.quoteIdent(t + '_import_errors') +
      ' (movement_id VARCHAR, row_num INTEGER CHECK (row_num < 0), error_description VARCHAR,' +
      ' underlying_sql VARCHAR, raw_row JSON, recorded_at TIMESTAMPTZ)');
  } });
  assert.equal(result.completed, 8);
  assert.equal(result.errorRows.recorded, 0);
  assert.equal(result.errorRows.notRecorded, 2);
  assert.match(result.errorRows.reason, /constraint/i);
  assert.equal(errs.length, 0);
});

test('a driver that cannot write the error table: counted as not recorded, saying why', async function() {
  var older = Object.assign({}, duckdb);
  delete older.buildInsertErrorRowsSql;
  var { result } = await load({ driver: older });
  assert.equal(result.completed, 8);
  assert.deepEqual(result.errorRows, { recorded: 0, notRecorded: 2, reason: 'this database driver cannot write the error table' });
});

test('more refused rows than one INSERT carries are all recorded', async function() {
  var t = tempTable();
  var pool = await duckdb.connect({ file: ':memory:', access: 'rw' });
  var connections = {}; connections[t] = pool;
  var q = new SqlQueue({ connections: connections, concurrency: 1, maxAttempts: 1,
    executor: async function(item, conn) { await duckdb.query(conn, item.sql, item.params || []); } });
  try {
    await duckdb.query(pool, 'CREATE TABLE ' + duckdb.quoteIdent(t) + ' (n INTEGER CHECK (n >= 0))');
    var rows = [];
    // Bad rows between good ones: five refusals IN A ROW make the queue give
    // up on the movement (maxConsecutiveDrops), which is a different case.
    for (var i = 1; i <= 450; i++) rows.push({ n: i }, { n: -i });
    var result = await upload({ source: rowsOf(rows), driver: duckdb, connection: pool,
      targetTable: t, movementId: 'mv-many', queue: q, batchSize: 1000 });
    assert.equal(result.completed, 450);
    assert.equal(result.dropped, 450);
    assert.deepEqual(result.errorRows, { recorded: 450, notRecorded: 0 });
    var n = await duckdb.query(pool, 'SELECT count(*)::INTEGER AS n FROM ' + duckdb.quoteIdent(t + '_import_errors'));
    assert.equal(n.rows[0].n, 450);
  } finally {
    q.stop();
    await duckdb.close(pool);
  }
});

test('every dialect gets the same statement in its own quoting and bind marks', function() {
  var entries = [{ rowNum: 5, error: 'bad', sql: 'INSERT …', row: { a: 1 } }, { rowNum: null, row: null }];
  var expected = {
    mysql:    ['`t_import_errors`', '?, ?, ?, ?, ?'],
    postgres: ['"t_import_errors"', '$6, $7, $8, $9, $10'],
    mssql:    ['[t_import_errors]', '@p5, @p6, @p7, @p8, @p9'],
    duckdb:   ['"t_import_errors"', '$6, $7, $8, $9, $10']
  };
  Object.keys(expected).forEach(function(d) {
    var built = require('../lib/drivers/db/' + d).buildInsertErrorRowsSql('t', 'mv', entries);
    assert.ok(built.sql.indexOf('INSERT INTO ' + expected[d][0]) === 0, d);
    assert.ok(built.sql.indexOf(expected[d][1]) > 0, d + ': ' + built.sql);
    assert.deepEqual(built.params, ['mv', 5, 'bad', 'INSERT …', '{"a":1}', 'mv', null, null, null, null], d);
  });
});
