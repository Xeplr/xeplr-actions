// @flags: --test-concurrency=1
// Stopping a query on a live SQL Server (MSSQL_HOST … MSSQL_PASSWORD;
// skipped without): a stop or a time limit cancels it IN THE SERVER —
// proven by its request being gone from sys.dm_exec_requests.
var db = require('../helpers/databases');
var test = db.testWith('mssql');
var assert = require('node:assert');
var sql = require('mssql');
var driver = require('../../lib/drivers/db/mssql');

var CONN = db.config('mssql', 'master');
var RUN = Date.now().toString(36);
var n = 0;
var watcher = null;

function marker() { n++; return 'xeplr_stop_' + RUN + '_' + n; }

async function running(mark) {
  var r = await watcher.request().input('m', '%' + mark + '%').query(
    'SELECT COUNT(*) AS n FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t ' +
    'WHERE t.text LIKE @m AND r.session_id <> @@SPID');
  return r.recordset[0].n > 0;
}

async function until(fn, ms) {
  var end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise(function(r) { setTimeout(r, 50); }); }
  return false;
}

function abortAfter(ms) {
  var c = new AbortController();
  setTimeout(function() { c.abort(new Error('Nobody is waiting for this')); }, ms);
  return c.signal;
}

test.before(async function() { watcher = await driver.connect(CONN); });
test.after(async function() { if (watcher) await driver.close(watcher); });

test('query: a stop cancels it in SQL Server', async function() {
  var pool = await driver.connect(CONN);
  var mark = marker();
  try {
    await assert.rejects(driver.query(pool, "/* " + mark + " */ WAITFOR DELAY '00:00:30'; SELECT 1 AS one", [], { signal: abortAfter(300) }),
      { code: 'QUERY_STOPPED', message: 'Nobody is waiting for this' });
    assert.equal(await until(async function() { return !(await running(mark)); }, 2000), true, 'gone from sys.dm_exec_requests');
    assert.equal((await driver.query(pool, 'SELECT 1 AS one')).rows[0].one, 1);
  } finally { await driver.close(pool); }
});

test('query: past its time limit it is cancelled', async function() {
  var pool = await driver.connect(CONN);
  var mark = marker();
  try {
    await assert.rejects(driver.query(pool, "/* " + mark + " */ WAITFOR DELAY '00:00:30'; SELECT 1 AS one", [], { timeoutMs: 400 }), { code: 'QUERY_TIMEOUT' });
    assert.equal(await until(async function() { return !(await running(mark)); }, 2000), true, 'gone from sys.dm_exec_requests');
  } finally { await driver.close(pool); }
});

test('fetchStream: a stop cancels it before the first row', async function() {
  var pool = await driver.connect(CONN);
  var mark = marker();
  try {
    var rows = driver.fetchStream(pool, { sql: "/* " + mark + " */ WAITFOR DELAY '00:00:30'; SELECT 1 AS one", signal: abortAfter(300) });
    await assert.rejects((async function() { for await (var r of rows) { void r; } })(), { code: 'QUERY_STOPPED' });
    assert.equal(await until(async function() { return !(await running(mark)); }, 2000), true, 'gone from sys.dm_exec_requests');
  } finally { await driver.close(pool); }
});

test('unstopped: answers as before', async function() {
  var pool = await driver.connect(CONN);
  try {
    assert.equal((await driver.query(pool, 'SELECT 5 AS five', [], { signal: new AbortController().signal, timeoutMs: 5000 })).rows[0].five, 5);
    var seen = 0;
    for await (var r of driver.fetchStream(pool, { sql: 'SELECT TOP 2500 1 AS x FROM sys.all_objects a CROSS JOIN sys.all_objects b', signal: new AbortController().signal, timeoutMs: 5000 })) { void r; seen++; }
    assert.equal(seen, 2500);
  } finally { await driver.close(pool); }
});
void sql;
