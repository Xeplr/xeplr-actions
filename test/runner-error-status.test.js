// A function's refusal keeps its HTTP status through runAction, so a route
// (a button press) answers 400 with its message rather than a 500.
var { test } = require('node:test');
var assert = require('node:assert/strict');
var actions = require('../index');

test('runAction keeps an error\'s HTTP status; drops anything that is not one', async function() {
  actions.register({ name: 'itestRefuses', event: 'button', inputSchema: [], execute: function() {
    var e = new Error('Give the invoice number'); e.status = 400; e.code = 'BAD_REQUEST'; throw e;
  } });
  actions.register({ name: 'itestOddStatus', event: 'button', inputSchema: [], execute: function() {
    var e = new Error('odd'); e.status = 'teapot'; throw e;
  } });
  var run = await actions.runAction({ name: 'itestRefuses', input: {} });
  assert.equal(run.status, 'failed');
  assert.deepEqual([run.error.message, run.error.status, run.error.code], ['Give the invoice number', 400, 'BAD_REQUEST']);
  run = await actions.runAction({ name: 'itestOddStatus', input: {} });
  assert.equal(run.error.status, undefined);
});
