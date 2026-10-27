// data-operation through runAction — the way every workflow step calls it.
//
// Its unit tests (test/builtins/) once called execute(input, context) directly,
// while the runner passes { input, system }. They passed, and every real step
// got `from` undefined and returned no rows.
var assert = require('node:assert');
var { test } = require('node:test');
var { runAction } = require('../lib/runner');
var op = require('../lib/builtins/data-operation');

var ROWS = [
  { name: 'Ada', status: 'active' },
  { name: 'Grace', status: 'done' },
  { name: 'Alan', status: 'active' }
];

test('a step gets its rows filtered and its columns picked', async function() {
  var res = await runAction(op, { from: ROWS, where: 'status = "active"', columns: ['name'] },
    { system: { formula: { today: '2026-01-20' } } });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.equal(res.output.count, 2);
  assert.deepEqual(res.output.rows, [{ name: 'Ada' }, { name: 'Alan' }]);
});

test('by name, as the workflow engine calls it, with no formula context', async function() {
  var actions = require('../index');
  actions.register(actions.builtins.dataOperation);
  var res = await runAction({ name: 'data-operation', input: { from: ROWS } });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.equal(res.output.count, 3);
});

test('says its columns, in order and with their headings, in export-table\'s shape', async function() {
  var res = await runAction(op, { from: ROWS, columns: ['status', { name: 'who', label: 'Who', formula: 'upper([name])' }, { name: 'name', hidden: true }] });
  assert.deepEqual(res.output.columns, [{ key: 'status', header: 'status' }, { key: 'who', header: 'Who' }]);

  // ...and export-table takes them as they are, whatever order the row's keys arrive in.
  var fs = require('fs');
  var os = require('os');
  var path = require('path');
  var file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dataop-')), 'out.csv');
  var reordered = res.output.rows.map(function(r) { return { who: r.who, name: r.name, status: r.status }; });
  var exp = await runAction(require('../lib/builtins/export/table'), { format: 'csv', outputPath: file, rows: reordered, document: { columns: res.output.columns } });
  assert.equal(exp.status, 'success', exp.error && exp.error.message);
  assert.deepEqual(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/), ['status,Who', 'active,ADA', 'done,GRACE', 'active,ALAN']);
});
