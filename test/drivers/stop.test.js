// The stop every driver shares (lib/drivers/db/stop.js): which error, when
// the cancel is called, and that a finished watch lets go of its signal.
var test = require('node:test');
var assert = require('node:assert');
var stop = require('../../lib/drivers/db/stop');

test('a signal that fires calls cancel once and keeps its reason', function() {
  var c = new AbortController();
  var calls = 0;
  var w = stop.watch(c.signal, 0, function() { calls++; });
  assert.equal(w.why(), null);
  c.abort(new Error('Left the page'));
  assert.equal(calls, 1);
  assert.equal(w.why().code, 'QUERY_STOPPED');
  assert.equal(w.why().message, 'Left the page');
  w.done();
});

test('already aborted: cancelled at once', function() {
  var c = new AbortController();
  c.abort();
  var calls = 0;
  var w = stop.watch(c.signal, 0, function() { calls++; });
  assert.equal(calls, 1);
  assert.equal(w.why().message, 'The query was stopped');
  assert.throws(function() { stop.throwIfStopped(c.signal); }, { code: 'QUERY_STOPPED' });
  w.done();
});

test('a time limit cancels with QUERY_TIMEOUT', async function() {
  var calls = 0;
  var w = stop.watch(null, 30, function() { calls++; });
  await new Promise(function(r) { setTimeout(r, 80); });
  assert.equal(calls, 1);
  assert.equal(w.why().code, 'QUERY_TIMEOUT');
  w.done();
});

test('done() before the limit: nothing is cancelled', async function() {
  var calls = 0;
  var c = new AbortController();
  var w = stop.watch(c.signal, 30, function() { calls++; });
  w.done();
  c.abort();
  await new Promise(function(r) { setTimeout(r, 80); });
  assert.equal(calls, 0);
  assert.equal(w.why(), null);
});

test('no signal and no limit: nothing to watch', function() {
  var w = stop.watch(undefined, undefined, function() { throw new Error('never'); });
  assert.equal(w.why(), null);
  w.done();
  assert.equal(stop.limitOf('abc'), 0);
  assert.equal(stop.limitOf(-5), 0);
  assert.equal(stop.limitOf(1500.7), 1500);
});

test('the limit as a person says it', function() {
  assert.equal(stop.durationText(400), '1 second');
  assert.equal(stop.durationText(45000), '45 seconds');
  assert.equal(stop.durationText(120000), '2 minutes');
  assert.equal(stop.durationText(60000), '1 minute');
});
