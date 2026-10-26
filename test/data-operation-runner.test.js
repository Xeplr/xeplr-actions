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
