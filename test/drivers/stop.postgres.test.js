// @flags: --test-concurrency=1
// Stopping a query on a live Postgres (PG_HOST … PG_PASSWORD): a stop or a
// time limit cancels it IN THE DATABASE — proven by its being gone from
// pg_stat_activity, not by our promise rejecting.
// Run:  node --test test/drivers/stop.postgres.test.js

var db = require('../helpers/databases');
var test = db.testWith('pg');
var assert = require('node:assert');
var pg = require('pg');
var driver = require('../../lib/drivers/db/postgres');

var CONN = db.config('pg', 'xeplr_actions_test');
var watcher = null;
var RUN = Date.now().toString(36);
var n = 0;

/** A marker no other query carries, so pg_stat_activity finds just this one. */
function marker() { n++; return 'xeplr_stop_' + RUN + '_' + n; }

/** Whether a query carrying `mark` is running in Postgres right now. */
async function running(mark) {
  var r = await watcher.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE $1 AND pid <> pg_backend_pid()", ['%' + mark + '%']);
  return r.rows[0].n > 0;
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

test.before(async function() {
  var admin = new pg.Pool(Object.assign({}, CONN, { database: 'postgres', connectionTimeoutMillis: 3000 }));
  var res = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['xeplr_actions_test']);
  if (res.rows.length === 0) await admin.query('CREATE DATABASE xeplr_actions_test');
  await admin.end();
  watcher = new pg.Pool(CONN);
});

test.after(async function() { if (watcher) await watcher.end(); });

test('query: a stop cancels it in Postgres, and says why', async function() {
  var pool = await driver.connect(CONN);
  var mark = marker();
  var started = Date.now();
  try {
    await assert.rejects(driver.query(pool, 'SELECT pg_sleep(30) /* ' + mark + ' */', [], { signal: abortAfter(300) }), function(e) {
      return e.code === 'QUERY_STOPPED' && e.message === 'Nobody is waiting for this';
    });
    assert.ok(Date.now() - started < 3000, 'stopped, not waited out');
    assert.equal(await until(async function() { return !(await running(mark)); }, 2000), true, 'gone from pg_stat_activity');
    assert.equal((await driver.query(pool, 'SELECT 1 AS one')).rows[0].one, 1, 'the pool still works');
  } finally { await driver.close(pool); }
});

test('query: past its time limit Postgres stops it', async function() {
  var pool = await driver.connect(CONN);
  var mark = marker();
  try {
    await assert.rejects(driver.query(pool, 'SELECT pg_sleep(30) /* ' + mark + ' */', [], { timeoutMs: 400 }), function(e) {
      return e.code === 'QUERY_TIMEOUT' && /after 1 second, its time limit/.test(e.message);
    });
    assert.equal(await until(async function() { return !(await running(mark)); }, 2000), true, 'gone from pg_stat_activity');
  } finally { await driver.close(pool); }
});

test('query: the time limit is put back afterwards on a writable connection', async function() {
  var pool = await driver.connect(Object.assign({}, CONN, { maxConnections: 1 }));
  try {
    assert.equal((await driver.query(pool, 'SELECT 2 AS two', [], { timeoutMs: 5000 })).rows[0].two, 2);
    assert.equal((await driver.query(pool, 'SHOW statement_timeout')).rows[0].statement_timeout, '0', 'the next query on the connection has no limit');
  } finally { await driver.close(pool); }
});

test('query: read-only, with every pooled connection busy, a stop still gets through', async function() {
  var pool = await driver.connect(Object.assign({}, CONN, { readOnly: true, maxConnections: 1 }));
  var mark = marker();
  try {
    await assert.rejects(driver.query(pool, 'SELECT pg_sleep(30) /* ' + mark + ' */', [], { signal: abortAfter(300) }), { code: 'QUERY_STOPPED' });
    assert.equal(await until(async function() { return !(await running(mark)); }, 2000), true, 'gone from pg_stat_activity');
    assert.equal((await driver.query(pool, 'SELECT 3 AS three')).rows[0].three, 3, 'the one connection is usable again');
  } finally { await driver.close(pool); }
});

test('query: already stopped — never sent', async function() {
  var pool = await driver.connect(CONN);
  var mark = marker();
  var c = new AbortController();
  c.abort(new Error('Gone'));
  try {
    await assert.rejects(driver.query(pool, 'SELECT pg_sleep(5) /* ' + mark + ' */', [], { signal: c.signal }), { code: 'QUERY_STOPPED', message: 'Gone' });
    assert.equal(await running(mark), false);
  } finally { await driver.close(pool); }
});

test('query: one that finishes inside its limit answers as before', async function() {
  var pool = await driver.connect(Object.assign({}, CONN, { readOnly: true }));
  try {
    var r = await driver.query(pool, 'SELECT 4 AS four', [], { signal: new AbortController().signal, timeoutMs: 5000 });
    assert.equal(r.rows[0].four, 4);
    assert.deepEqual(r.columns, ['four']);
  } finally { await driver.close(pool); }
});

test('fetchStream: a stop cancels the slow first FETCH in Postgres', async function() {
  var pool = await driver.connect(Object.assign({}, CONN, { readOnly: true }));
  var mark = marker();
  var started = Date.now();
  try {
    var rows = driver.fetchStream(pool, { sql: 'SELECT s.x FROM (SELECT pg_sleep(30) AS x /* ' + mark + ' */) s', signal: abortAfter(300) });
    await assert.rejects((async function() { for await (var r of rows) { void r; } })(), { code: 'QUERY_STOPPED' });
    assert.ok(Date.now() - started < 3000, 'stopped, not waited out');
    assert.equal(await until(async function() { return !(await running(mark)); }, 2000), true, 'gone from pg_stat_activity');
  } finally { await driver.close(pool); }
});

test('fetchStream: past its time limit Postgres stops it', async function() {
  var pool = await driver.connect(CONN);
  var mark = marker();
  try {
    var rows = driver.fetchStream(pool, { sql: 'SELECT s.x FROM (SELECT pg_sleep(30) AS x /* ' + mark + ' */) s', timeoutMs: 400 });
    await assert.rejects((async function() { for await (var r of rows) { void r; } })(), { code: 'QUERY_TIMEOUT' });
    assert.equal(await until(async function() { return !(await running(mark)); }, 2000), true, 'gone from pg_stat_activity');
  } finally { await driver.close(pool); }
});

test('fetchStream: a stop between batches ends the read', async function() {
  var pool = await driver.connect(CONN);
  var c = new AbortController();
  try {
    var seen = 0;
    var rows = driver.fetchStream(pool, { sql: 'SELECT g FROM generate_series(1, 10000) g', batchSize: 100, signal: c.signal });
    await assert.rejects((async function() {
      for await (var r of rows) { void r; seen++; if (seen === 150) c.abort(new Error('Left the page')); }
    })(), { code: 'QUERY_STOPPED', message: 'Left the page' });
    assert.ok(seen <= 200, 'stopped within a batch, read ' + seen);
  } finally { await driver.close(pool); }
});

test('fetchStream: unstopped, every row as before', async function() {
  var pool = await driver.connect(Object.assign({}, CONN, { readOnly: true }));
  try {
    var total = 0;
    for await (var r of driver.fetchStream(pool, { sql: 'SELECT g FROM generate_series(1, 2500) g', batchSize: 1000, signal: new AbortController().signal, timeoutMs: 5000 })) total += r.g;
    assert.equal(total, 2500 * 2501 / 2);
  } finally { await driver.close(pool); }
});
