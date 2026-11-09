// @flags: --test-concurrency=1
// Stopping a query on a live MySQL (MYSQL_HOST … MYSQL_PASSWORD; skipped
// without): a stop or a time limit KILLs it in the server — proven by its
// thread no longer running it in the processlist.
var db = require('../helpers/databases');
var test = db.testWith('mysql');
var assert = require('node:assert');
var driver = require('../../lib/drivers/db/mysql');

var CONN = db.config('mysql');
var RUN = Date.now().toString(36);
var n = 0;
var watcher = null;

function marker() { n++; return 'xeplr_stop_' + RUN + '_' + n; }

async function running(mark) {
  var r = await driver.query(watcher, "SELECT COUNT(*) AS n FROM information_schema.processlist WHERE command = 'Query' AND info LIKE ? AND id <> CONNECTION_ID()", ['%' + mark + '%']);
  return Number(r.rows[0].n) > 0;
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

test('query: a stop kills it in MySQL', async function() {
  var pool = await driver.connect(Object.assign({}, CONN, { maxConnections: 1 }));
  var mark = marker();
  try {
    await assert.rejects(driver.query(pool, 'SELECT SLEEP(30) /* ' + mark + ' */', [], { signal: abortAfter(300) }),
      { code: 'QUERY_STOPPED', message: 'Nobody is waiting for this' });
    assert.equal(await until(async function() { return !(await running(mark)); }, 2000), true, 'gone from the processlist');
    assert.equal(Number((await driver.query(pool, 'SELECT 1 AS one')).rows[0].one), 1, 'the pool still works');
  } finally { await driver.close(pool); }
});

test('query: past its time limit it is killed', async function() {
  var pool = await driver.connect(CONN);
  var mark = marker();
  try {
    await assert.rejects(driver.query(pool, 'SELECT SLEEP(30) /* ' + mark + ' */', [], { timeoutMs: 400 }), { code: 'QUERY_TIMEOUT' });
    assert.equal(await until(async function() { return !(await running(mark)); }, 2000), true, 'gone from the processlist');
  } finally { await driver.close(pool); }
});

test('fetchStream: a stop kills it before the first row', async function() {
  var pool = await driver.connect(CONN);
  var mark = marker();
  try {
    var rows = driver.fetchStream(pool, { sql: 'SELECT SLEEP(30) AS s /* ' + mark + ' */', signal: abortAfter(300) });
    await assert.rejects((async function() { for await (var r of rows) { void r; } })(), { code: 'QUERY_STOPPED' });
    assert.equal(await until(async function() { return !(await running(mark)); }, 2000), true, 'gone from the processlist');
  } finally { await driver.close(pool); }
});

test('unstopped: answers as before', async function() {
  var pool = await driver.connect(CONN);
  try {
    assert.equal(Number((await driver.query(pool, 'SELECT 5 AS five', [], { signal: new AbortController().signal, timeoutMs: 5000 })).rows[0].five), 5);
  } finally { await driver.close(pool); }
});
