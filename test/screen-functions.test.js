// Screen functions: ordinary registrations with an `event`, kept and listed so
// a picker offers each event only the functions written for it.
// Run: node --test test/screen-functions.test.js
var test = require('node:test');
var assert = require('node:assert');
var actions = require('../index');

test('a function registered for an event keeps it, and is listed with it', function() {
  actions.clear();
  actions.register({ name: 'checkSalaryBand', event: 'beforeSave', description: 'Refuses a salary outside the band', execute: function(ctx) { return ctx.values; } });
  actions.register({ name: 'sendEmail', execute: function() {} });
  var byName = Object.fromEntries(actions.list().map(function(a) { return [a.name, a]; }));
  assert.equal(byName.checkSalaryBand.event, 'beforeSave');
  assert.equal(byName.checkSalaryBand.description, 'Refuses a salary outside the band');
  assert.equal(byName.sendEmail.event, null, 'an ordinary action has no event');
  assert.equal(actions.get('checkSalaryBand').event, 'beforeSave');
});

test('it is called with the event context it is given, not { input, system }', async function() {
  actions.clear();
  actions.register({ name: 'upper', event: 'beforeSave', execute: function(ctx) { return { name: ctx.values.name.toUpperCase() }; } });
  assert.deepEqual(await actions.get('upper').execute({ values: { name: 'ada' } }), { name: 'ADA' });
});

test('an event that is not a name is refused at register', function() {
  actions.clear();
  assert.throws(function() { actions.register({ name: 'x', event: '', execute: function() {} }); }, /not a name/);
  assert.throws(function() { actions.register({ name: 'y', event: 42, execute: function() {} }); }, /not a name/);
});
