// Stopping a query in DuckDB, in this process: a stop or a time limit
// interrupts it on its own connection. With one connection in the pool, the
// next query answering at once is the proof the engine let go — an
// unstopped one would hold that connection for minutes.
var test = require('node:test');
var assert = require('node:assert');
var driver = require('../../lib/drivers/db/duckdb');

// About 10^10 rows to add up: minutes of work, unless it is stopped.
var SLOW = 'SELECT sum(a.range * b.range) AS s FROM range(100000) a, range(100000) b';

function abortAfter(ms) {
  var c = new AbortController();
  setTimeout(function() { c.abort(new Error('Nobody is waiting for this')); }, ms);
  return c.signal;
}

async function onePool() {
  return driver.connect({ file: ':memory:', access: 'rw', maxConnections: 1 });
}

async function answersAtOnce(pool) {
  var started = Date.now();
  var r = await driver.query(pool, 'SELECT 42 AS n');
  assert.equal(Number(r.rows[0].n), 42);
  assert.ok(Date.now() - started < 1000, 'the one connection was free again');
}

test('query: a stop interrupts it in DuckDB', async function() {
  var pool = await onePool();
  var started = Date.now();
  try {
    await assert.rejects(driver.query(pool, SLOW, [], { signal: abortAfter(200) }), { code: 'QUERY_STOPPED', message: 'Nobody is waiting for this' });
    assert.ok(Date.now() - started < 3000, 'stopped, not waited out');
    await answersAtOnce(pool);
  } finally { await driver.close(pool); }
});

test('query: past its time limit it is interrupted', async function() {
  var pool = await onePool();
  try {
    await assert.rejects(driver.query(pool, SLOW, [], { timeoutMs: 300 }), { code: 'QUERY_TIMEOUT' });
    await answersAtOnce(pool);
  } finally { await driver.close(pool); }
});

test('query: waiting for a connection, a stop lets go before it runs', async function() {
  var pool = await onePool();
  try {
    var busy = driver.query(pool, SLOW, [], { timeoutMs: 1500 });
    var c = new AbortController();
    var waiting = driver.query(pool, 'SELECT 1 AS one', [], { signal: c.signal });
    setTimeout(function() { c.abort(new Error('Gone')); }, 100);
    await assert.rejects(waiting, { code: 'QUERY_STOPPED', message: 'Gone' });
    await assert.rejects(busy, { code: 'QUERY_TIMEOUT' });
    await answersAtOnce(pool);
  } finally { await driver.close(pool); }
});

test('fetchStream: a stop interrupts the slow first chunk', async function() {
  var pool = await onePool();
  try {
    var rows = driver.fetchStream(pool, { sql: SLOW, signal: abortAfter(200) });
    await assert.rejects((async function() { for await (var r of rows) { void r; } })(), { code: 'QUERY_STOPPED' });
    await answersAtOnce(pool);
  } finally { await driver.close(pool); }
});

test('fetchStream: a stop between chunks ends the read', async function() {
  var pool = await onePool();
  var c = new AbortController();
  try {
    var seen = 0;
    var rows = driver.fetchStream(pool, { sql: 'SELECT range AS g FROM range(100000)', signal: c.signal });
    await assert.rejects((async function() {
      for await (var r of rows) { void r; seen++; if (seen === 10) c.abort(new Error('Left the page')); }
    })(), { code: 'QUERY_STOPPED', message: 'Left the page' });
    assert.ok(seen < 100000, 'not read to the end');
    await answersAtOnce(pool);
  } finally { await driver.close(pool); }
});

test('unstopped: answers as before', async function() {
  var pool = await onePool();
  try {
    var r = await driver.query(pool, 'SELECT 7 AS seven', [], { signal: new AbortController().signal, timeoutMs: 5000 });
    assert.equal(Number(r.rows[0].seven), 7);
    var total = 0;
    for await (var row of driver.fetchStream(pool, { sql: 'SELECT range AS g FROM range(5000)', signal: new AbortController().signal, timeoutMs: 5000 })) total += Number(row.g);
    assert.equal(total, 4999 * 5000 / 2);
  } finally { await driver.close(pool); }
});
