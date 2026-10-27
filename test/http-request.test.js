// http-request against a real HTTP server on this machine: every way of
// signing in, a token reused and renewed, retries, refusals, and bodies.
var assert = require('node:assert');
var { test, before, after } = require('node:test');
var http = require('node:http');
var { runAction } = require('../lib/runner');
var op = require('../lib/builtins/http-request');

var server, base;
var seen = [];
var logins = 0;
var tokenAccepted = 'tok-1';
var flaky = 0;

before(async function() {
  server = http.createServer(function(req, res) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() {
      var body = Buffer.concat(chunks).toString();
      var u = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body: body });
      var json = function(status, obj, extra) { res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, extra || {})); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/v2/statements') return json(200, { rows: [{ ref: 'A1', amount: 500 }] }, { 'x-total-count': '1' });
      if (u.pathname === '/v2/echo') return json(200, { method: req.method, body: body, type: req.headers['content-type'] || null });
      if (u.pathname === '/login') { logins++; return json(200, { data: { token: 'tok-' + logins, expires: 3600 } }); }
      if (u.pathname === '/oauth/token') { logins++; return json(200, { access_token: 'tok-' + logins, expires_in: 3600 }); }
      if (u.pathname === '/v2/secure') {
        return req.headers.authorization === 'Bearer ' + tokenAccepted ? json(200, { fine: true }) : json(401, { error: 'expired' });
      }
      if (u.pathname === '/v2/flaky') { flaky++; return flaky < 3 ? json(503, { busy: true }, { 'retry-after': '0' }) : json(200, { after: flaky }); }
      if (u.pathname === '/v2/nope') return json(404, { error: 'no such statement' });
      if (u.pathname === '/v2/slow') return setTimeout(function() { json(200, {}); }, 3000);
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('plain words');
    });
  });
  await new Promise(function(r) { server.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(function() { server.close(); });

var last = function() { return seen[seen.length - 1]; };
var conn = function(auth, extra) { return Object.assign({ baseUrl: base + '/v2', auth: auth }, extra || {}); };

test('a path on the connection, with query values, gives the parsed answer', async function() {
  var res = await runAction(op, { connection: conn({ type: 'none' }), path: '/statements', query: { from: '2026-09-01', skip: '' } });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.deepEqual(res.output.body, { rows: [{ ref: 'A1', amount: 500 }] });
  assert.equal(res.output.status, 200);
  assert.equal(res.output.headers['x-total-count'], '1');
  assert.deepEqual(last().query, { from: '2026-09-01' });
});

test('an API key, in a header or in the address; a token; a username and password', async function() {
  await runAction(op, { connection: conn({ type: 'apiKey', in: 'header', name: 'X-API-Key', value: 'k1' }), path: 'x' });
  assert.equal(last().headers['x-api-key'], 'k1');
  await runAction(op, { connection: conn({ type: 'apiKey', in: 'query', name: 'key', value: 'k2' }), path: 'x' });
  assert.equal(last().query.key, 'k2');
  await runAction(op, { connection: conn({ type: 'bearer', token: 't9' }), path: 'x' });
  assert.equal(last().headers.authorization, 'Bearer t9');
  await runAction(op, { connection: conn({ type: 'basic', username: 'ann', password: 'pw' }), path: 'x' });
  assert.equal(last().headers.authorization, 'Basic ' + Buffer.from('ann:pw').toString('base64'));
  await runAction(op, { connection: conn({ type: 'none' }, { headers: { 'X-Tenant': 'acme' } }), path: 'x', headers: { 'X-Step': 'yes' } });
  assert.equal(last().headers['x-tenant'], 'acme');
  assert.equal(last().headers['x-step'], 'yes');
});

test('a login call first: its token is used, kept, and renewed once when refused', async function() {
  op._forgetTokens(); logins = 0; tokenAccepted = 'tok-1';
  var c = conn({ type: 'login', url: base + '/login', body: { user: 'ann', password: 'pw' }, tokenPath: 'data.token', expiresInPath: 'data.expires' });
  var first = await runAction(op, { connection: c, path: '/secure' });
  assert.equal(first.status, 'success', first.error && first.error.message);
  await runAction(op, { connection: c, path: '/secure' });
  assert.equal(logins, 1, 'signed in once for two calls');
  assert.deepEqual(JSON.parse(seen.find(function(s) { return s.path === '/login'; }).body), { user: 'ann', password: 'pw' });
  tokenAccepted = 'tok-2';
  var renewed = await runAction(op, { connection: c, path: '/secure' });
  assert.equal(renewed.status, 'success', renewed.error && renewed.error.message);
  assert.equal(logins, 2, 'refused once, signed in again, and it worked');
});

test('a login answer with no token fails, saying where it looked', async function() {
  op._forgetTokens();
  var res = await runAction(op, { connection: conn({ type: 'login', url: base + '/login', tokenPath: 'access_token' }), path: '/secure' });
  assert.equal(res.error.code, 'SIGN_IN_FAILED');
  assert.match(res.error.message, /no token in the answer at "access_token"/);
});

test('OAuth2 client credentials: a form to the token address, the token used', async function() {
  op._forgetTokens(); logins = 0; tokenAccepted = 'tok-1';
  var res = await runAction(op, { connection: conn({ type: 'oauth2', tokenUrl: base + '/oauth/token', clientId: 'id1', clientSecret: 's1', scope: 'read' }), path: '/secure' });
  assert.equal(res.status, 'success', res.error && res.error.message);
  var form = new URLSearchParams(seen.find(function(s) { return s.path === '/oauth/token'; }).body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_id'), 'id1');
  assert.equal(form.get('scope'), 'read');
});

test('busy (503 / 429) is tried again; a refusal (404) is not, and says so', async function() {
  flaky = 0;
  var res = await runAction(op, { connection: conn({ type: 'none' }), path: '/flaky', retryAfterMs: 1 });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.deepEqual(res.output.body, { after: 3 });
  var before404 = seen.length;
  var nope = await runAction(op, { connection: conn({ type: 'none' }), path: '/nope', retryAfterMs: 1 });
  assert.equal(nope.error.code, 'HTTP_404');
  assert.match(nope.error.message, /GET \/v2\/nope answered 404: \{"error":"no such statement"\}/);
  assert.equal(seen.length - before404, 1, 'not retried');
  var kept = await runAction(op, { connection: conn({ type: 'none' }), path: '/nope', failOnError: false });
  assert.equal(kept.status, 'success');
  assert.equal(kept.output.status, 404);
  assert.equal(kept.output.ok, false);
});

test('bodies: JSON by default, a form, plain text; text answers stay text', async function() {
  var j = await runAction(op, { connection: conn({ type: 'none' }), method: 'POST', path: '/echo', body: { rows: [1, 2] } });
  assert.equal(j.output.body.type, 'application/json');
  assert.equal(j.output.body.body, '{"rows":[1,2]}');
  var f = await runAction(op, { connection: conn({ type: 'none' }), method: 'POST', path: '/echo', body: { a: 'x y' }, bodyType: 'form' });
  assert.equal(f.output.body.body, 'a=x+y');
  var t = await runAction(op, { path: base + '/anything' });
  assert.equal(t.output.body, 'plain words');
});

test('a saved connection signs in to its own address only', async function() {
  var res = await runAction(op, { connection: conn({ type: 'bearer', token: 'secret' }), path: 'https://elsewhere.example/steal' });
  assert.equal(res.error.code, 'URL_NOT_ON_CONNECTION');
  var none = await runAction(op, { path: '/statements' });
  assert.equal(none.error.code, 'URL_REQUIRED');
  var odd = await runAction(op, { connection: conn({ type: 'kerberos' }), path: 'x' });
  assert.equal(odd.error.code, 'AUTH_UNKNOWN');
});

test('no answer in time, or nobody there, says so', async function() {
  var slow = await runAction(op, { connection: conn({ type: 'none' }), path: '/slow', timeoutMs: 1000, retries: 0 });
  assert.equal(slow.error.code, 'UNREACHABLE');
  assert.match(slow.error.message, /no answer within 1000 ms/);
  var gone = await runAction(op, { path: 'http://127.0.0.1:9/x', retries: 0 });
  assert.equal(gone.error.code, 'UNREACHABLE');
});
