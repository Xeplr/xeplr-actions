// push-send: the target and message handed to @xeplr/push, and every refusal
// said by name. @xeplr/push is an optional peer, so it is stood in for here.
var test = require('node:test');
var assert = require('node:assert');
var Module = require('module');

var pushSend = require('../../lib/builtins/push-send');
var actions = require('../../index');

function withPush(fake, fn) {
  var load = Module._load;
  Module._load = function(request) {
    if (request === '@xeplr/push') {
      if (fake === null) { var e = new Error("Cannot find module '@xeplr/push'"); e.code = 'MODULE_NOT_FOUND'; throw e; }
      return fake;
    }
    return load.apply(this, arguments);
  };
  return Promise.resolve().then(fn).finally(function() { Module._load = load; });
}

test('it is a built-in, and sends to everyone named — emails and ids, bare strings wrapped', async function() {
  assert.strictEqual(actions.builtins.pushSend, pushSend);
  var calls = [];
  var fake = { enabled: function() { return true; }, send: async function(target, message) { calls.push([target, message]); return { devices: 2, sent: 2, removed: 0, failed: 0 }; } };
  var out = await withPush(fake, function() {
    return pushSend.execute({ input: { emails: 'neha@x.com', userIds: ['u1', ' '], title: 'RTO: #GA1', body: 'Customer refused', url: '/orders/1', tag: 'rto-1' } });
  });
  assert.deepStrictEqual(out, { devices: 2, sent: 2, removed: 0, failed: 0 });
  assert.deepStrictEqual(calls[0], [{ emails: ['neha@x.com'], userIds: ['u1'] }, { title: 'RTO: #GA1', body: 'Customer refused', url: '/orders/1', tag: 'rto-1' }]);
});

test('refused by name: not installed, not set up, nobody to send to', async function() {
  await withPush(null, function() {
    return assert.rejects(pushSend.execute({ input: { emails: ['a@x.com'], title: 'T' } }), /npm install @xeplr\/push/);
  });
  await withPush({ enabled: function() { return false; } }, function() {
    return assert.rejects(pushSend.execute({ input: { emails: ['a@x.com'], title: 'T' } }), /not set up on this server/);
  });
  await withPush({ enabled: function() { return true; }, send: async function() { throw new Error('not asked'); } }, function() {
    return assert.rejects(pushSend.execute({ input: { title: 'T' } }), /say who gets it/);
  });
});

test('its form: title required, a tag tucked under Message options', function() {
  var byName = {};
  pushSend.inputSchema.forEach(function(f) { byName[f.name] = f; });
  assert.strictEqual(byName.title.required, true);
  assert.strictEqual(byName.tag.group, 'Message options');
  assert.deepStrictEqual(Object.keys(pushSend.example), ['devices', 'sent', 'removed', 'failed']);
});
