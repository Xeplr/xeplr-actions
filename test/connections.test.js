// Saved connections: an id in the definition, the login only in the call.
var assert = require('node:assert');
var { test } = require('node:test');
var { resolveConnections, connectionFieldFor } = require('../lib/connections');

var LOGINS = {
  c1: { dbType: 'postgres', connection: { host: 'db1', user: 'u', password: 'secret' } },
  c2: { host: 'db2', user: 'v', password: 'other' }
};
function resolver(id, ctx) { seen.push([id, ctx.field, ctx.inputs.dbInfoId || null]); return LOGINS[id] || null; }
var seen = [];

test('the field a connection id fills, by its name', function() {
  assert.equal(connectionFieldFor('connectionInfoId'), 'connection');
  assert.equal(connectionFieldFor('sourceConnectionInfoId'), 'sourceConnection');
  assert.equal(connectionFieldFor('dbInfoId'), null);
});

test('an id becomes the login, the type comes with it, and the id goes no further', async function() {
  seen = [];
  var given = { connectionInfoId: 'c1', dbInfoId: 'd9', table: 't' };
  var out = await resolveConnections(given, resolver);
  assert.deepEqual(out, { connection: LOGINS.c1.connection, dbType: 'postgres', dbInfoId: 'd9', table: 't' });
  assert.deepEqual(given, { connectionInfoId: 'c1', dbInfoId: 'd9', table: 't' }, 'what was given is left as it was, so a record of it holds no secret');
  assert.deepEqual(seen, [['c1', 'connectionInfoId', 'd9']], 'the resolver sees the whole inputs, for a companion id');
});

test('two connections in one step, each to its own field', async function() {
  var out = await resolveConnections({ sourceConnectionInfoId: 'c1', targetConnectionInfoId: 'c2' }, resolver);
  assert.equal(out.sourceConnection.host, 'db1');
  assert.equal(out.sourceConnectionDbType, 'postgres');
  assert.equal(out.targetConnection.host, 'db2');
});

test('no id: the inputs as they are, and no resolver needed', async function() {
  var given = { connection: { host: 'literal' } };
  assert.strictEqual(await resolveConnections(given, null), given);
});

test('an id that resolves to nothing is refused, never replaced by a literal connection', async function() {
  await assert.rejects(resolveConnections({ connectionInfoId: 'gone', connection: { host: 'literal' } }, resolver),
    function(e) { return e.code === 'CONNECTION_NOT_FOUND' && /"gone".*Refusing to run/.test(e.message); });
});

test('an id with no resolver configured is refused, naming who asked', async function() {
  await assert.rejects(resolveConnections({ connectionInfoId: 'c1' }, null, 'Step fetch'),
    function(e) { return e.code === 'NO_CONNECTION_RESOLVER' && /^Step fetch names a saved connection \(connectionInfoId\)/.test(e.message); });
});
