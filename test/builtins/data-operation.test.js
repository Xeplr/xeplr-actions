// data-operation — the step between steps.
//
// A fetch returns everything a table holds; an email wants four columns, the
// active rows, sorted, sometimes rendered. Every one of those would otherwise
// be a module somebody writes, and the third would be written differently
// from the first two.
var assert = require('node:assert');
var { test } = require('node:test');
var op = require('../../lib/builtins/data-operation');

var ROWS = [
  { name: 'Ada', status: 'active', due: '2026-01-12', owner: 'ops', id: 1 },
  { name: 'Grace', status: 'done', due: '2026-02-01', owner: 'ops', id: 2 },
  { name: 'Alan', status: 'active', due: '2026-01-30', owner: 'eng', id: 3 }
];
var AT = { formula: { today: '2026-01-20' } };

test('keeps only the rows the condition is true for', async function() {
  var out = await op.execute({ from: ROWS, where: 'status = "active"' }, AT);
  assert.equal(out.count, 2);
  assert.deepEqual(out.rows.map(function(r) { return r.name; }), ['Ada', 'Alan']);
});

test('no condition keeps everything, and no columns keeps every column', async function() {
  var out = await op.execute({ from: ROWS }, AT);
  assert.equal(out.count, 3);
  assert.deepEqual(Object.keys(out.rows[0]), ['name', 'status', 'due', 'owner', 'id']);
});

test('a list is what it always gets: one object is one row, nothing is none', async function() {
  // The step after this one should never have to ask which shape it received.
  assert.equal((await op.execute({ from: ROWS[0] }, AT)).count, 1);
  assert.equal((await op.execute({ from: null }, AT)).count, 0);
  assert.equal((await op.execute({ from: [] }, AT)).count, 0);
});

test('picks and renames columns, in the order asked for', async function() {
  var out = await op.execute({ from: ROWS, columns: ['due', 'name'] }, AT);
  assert.deepEqual(Object.keys(out.rows[0]), ['due', 'name']);
  assert.equal(out.rows[0].owner, undefined);
});

test('computes a column with the formula engine', async function() {
  var out = await op.execute({
    from: ROWS,
    columns: ['name', { name: 'late', label: 'Days late', formula: 'datediff([due], today())' }]
  }, AT);
  // 2026-01-12 → 2026-01-20 is eight days; the run's context says what today
  // is, so this does not change tomorrow.
  assert.equal(out.rows[0].late, 8);
});

test('the run\'s context decides what today and yesterday mean', async function() {
  var recent = await op.execute({ from: ROWS, where: '[due] >= yesterday()' }, { formula: { today: '2026-01-30' } });
  assert.deepEqual(recent.rows.map(function(r) { return r.name; }), ['Grace', 'Alan']);

  // The boundary is the day itself: on the 2nd, yesterday IS the 1st, so a
  // row due that day is still in.
  var onTheDay = await op.execute({ from: ROWS, where: '[due] >= yesterday()' }, { formula: { today: '2026-02-02' } });
  assert.deepEqual(onTheDay.rows.map(function(r) { return r.name; }), ['Grace']);

  // The same step and the same rows, a day later: what a run filtered is a
  // fact about WHEN it ran, which is why the context carries it rather than
  // the action calling new Date().
  var later = await op.execute({ from: ROWS, where: '[due] >= yesterday()' }, { formula: { today: '2026-02-03' } });
  assert.equal(later.count, 0);
});

test('sorts, ascending or descending, with empty cells last either way', async function() {
  var up = await op.execute({ from: ROWS, sort: 'due' }, AT);
  assert.deepEqual(up.rows.map(function(r) { return r.name; }), ['Ada', 'Alan', 'Grace']);

  var down = await op.execute({ from: ROWS, sort: '-due' }, AT);
  assert.deepEqual(down.rows.map(function(r) { return r.name; }), ['Grace', 'Alan', 'Ada']);

  // An empty cell is not the smallest value, it is the absence of one —
  // burying it at the top of a descending list is how it gets missed.
  var ragged = await op.execute({ from: [{ a: 2 }, { a: null }, { a: 1 }], sort: '-a' }, AT);
  assert.deepEqual(ragged.rows.map(function(r) { return r.a; }), [2, 1, null]);
});

test('a row missing a column does not fail the step', async function() {
  // Rows out of a real system are ragged; one of them should not take the
  // other nine hundred down.
  var out = await op.execute({ from: [{ name: 'Ada', status: 'active' }, { name: 'Bob' }], where: 'status = "active"' }, AT);
  assert.equal(out.count, 1);
});

test('gives no html until it is asked for', async function() {
  var plain = await op.execute({ from: ROWS }, AT);
  assert.equal(plain.html, undefined);
  assert.equal(plain.text, undefined);

  var shown = await op.execute({ from: ROWS, format: true }, AT);
  assert.match(shown.html, /<table/);
  assert.ok(shown.text.length > 0);
});

test('formats only the visible columns', async function() {
  var out = await op.execute({
    from: ROWS,
    columns: ['name', { name: 'id', hidden: true }],
    format: true
  }, AT);
  // Kept for the next step, not printed for a person.
  assert.equal(out.rows[0].id, 1);
  assert.doesNotMatch(out.html, /<th[^>]*>id</);
  assert.doesNotMatch(out.text, /\bid\b/);
});

test('a cell can never become markup', async function() {
  var out = await op.execute({ from: [{ name: '<script>alert(1)</script>' }], format: true }, AT);
  assert.doesNotMatch(out.html, /<script>/);
  assert.match(out.html, /&lt;script&gt;/);
});

test('says so when there is nothing left, rather than drawing an empty table', async function() {
  var out = await op.execute({ from: ROWS, where: 'status = "cancelled"', format: true, emptyText: 'No overdue items' }, AT);
  assert.equal(out.count, 0);
  assert.match(out.html, /No overdue items/);
  assert.doesNotMatch(out.html, /<table/);
  assert.match(out.text, /No overdue items/);
});

test('a formula that cannot be read is refused, saying which one', async function() {
  await assert.rejects(
    () => op.execute({ from: ROWS, where: 'status = = "active"' }, AT),
    function(err) { return /the condition/.test(err.message) && err.status === 400; }
  );
  await assert.rejects(
    () => op.execute({ from: ROWS, columns: [{ name: 'x', label: 'Total', formula: '1 +' }] }, AT),
    function(err) { return /"Total"/.test(err.message); }
  );
});
