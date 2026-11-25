// get-access-token and http-request's signInWith, against a real HTTP server
// on this machine: a token got, kept, renewed (expiry, lastsSeconds, 401,
// refresh token, a refused refresh), sent only where it is for, never the
// password in what comes back — and kept in Redis for another process, sealed,
// apart per tenant.
var assert = require('node:assert');
var { test, before, after, beforeEach } = require('node:test');
var http = require('node:http');
var path = require('node:path');
var { execFileSync } = require('node:child_process');
var { runAction } = require('../lib/runner');
var tokenStep = require('../lib/builtins/get-access-token');
var httpStep = require('../lib/builtins/http-request');
var signIn = require('../lib/signIn');
var db = require('@xeplr/db');

var server, base;
var logins = 0, refreshes = 0, refuseRefresh = false;
var live = new Set();          // tokens the API takes
var lastLoginBody = null;

before(async function() {
  server = http.createServer(function(req, res) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() {
      var body = Buffer.concat(chunks).toString();
      var u = new URL(req.url, 'http://x');
      var json = function(status, obj) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/api/login') {
        lastLoginBody = { type: req.headers['content-type'], body: body };
        var sent = /json/.test(req.headers['content-type'] || '') ? JSON.parse(body || '{}') : Object.fromEntries(new URLSearchParams(body));
        if (sent.password !== 's3cret') return json(401, { error: 'wrong password' });
        logins++;
        var t = 'tok-' + logins;
        live.add(t);
        return json(200, { data: { token: t, expires_in: Number(u.searchParams.get('life') || 3600) }, refresh: 'rt-' + logins });
      }
      if (u.pathname === '/api/plain-login') {     // says nothing about how long it lasts
        logins++; var p = 'plain-' + logins; live.add(p);
        return json(200, { access_token: p });
      }
      if (u.pathname === '/api/refresh') {
        var r = JSON.parse(body || '{}');
        if (refuseRefresh || !/^rt-/.test(r.refresh_token || '')) return json(400, { error: 'invalid_grant' });
        refreshes++; var n = 'ref-' + refreshes; live.add(n);
        return json(200, { data: { token: n, expires_in: 3600 } });
      }
      if (u.pathname === '/api/rates') {
        var auth = req.headers.authorization || '';
        var tok = auth.replace(/^(Bearer|Token) /, '');
        if (!live.has(tok)) return json(401, { error: 'expired' });
        return json(200, { rates: [{ zone: 'A', price: 50 }], as: auth });
      }
      if (u.pathname === '/api/slow') return setTimeout(function() { json(200, {}); }, 3000);
      json(404, {});
    });
  });
  await new Promise(function(r) { server.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(function() { server.close(); });
beforeEach(function() { signIn._forgetAll(); refuseRefresh = false; });

var login = function(extra) {
  return Object.assign({ loginUrl: base + '/api/login', body: { username: 'ops', password: 's3cret' }, tokenPath: 'data.token', expiresInPath: 'data.expires_in' }, extra || {});
};

test('signs in and hands back only the token and how to send it — never the password or the answer', async function() {
  var res = await runAction(tokenStep, login());
  assert.equal(res.status, 'success', res.error && res.error.message);
  var out = res.output;
  assert.match(out.token, /^tok-\d+$/);
  assert.equal(out.header, 'Authorization');
  assert.equal(out.value, 'Bearer ' + out.token);
  assert.equal(out.origin, base);
  assert.ok(out.ref && out.expiresAt);
  assert.deepEqual(Object.keys(out).sort(), ['expiresAt', 'header', 'origin', 'prefix', 'ref', 'token', 'value']);
  assert.ok(!JSON.stringify(out).includes('s3cret'), 'the password is never in the output');
  // ~3600 s from now
  var left = Date.parse(out.expiresAt) - Date.now();
  assert.ok(left > 3500e3 && left <= 3600e3, 'expires from the answer: ' + left);
});

test('kept while it lasts: a second step does not sign in again', async function() {
  var before = logins;
  var a = await runAction(tokenStep, login());
  var b = await runAction(tokenStep, login());
  assert.equal(a.output.token, b.output.token);
  assert.equal(logins, before + 1);
});

test('a form login, and a token prefix other than Bearer', async function() {
  var res = await runAction(tokenStep, login({ bodyType: 'form', prefix: 'Token', header: 'Authorization' }));
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.equal(lastLoginBody.type, 'application/x-www-form-urlencoded');
  assert.equal(res.output.value, 'Token ' + res.output.token);
  var call = await runAction(httpStep, { path: base + '/api/rates', signInWith: res.output });
  assert.equal(call.status, 'success', call.error && call.error.message);
  assert.equal(call.output.body.as, 'Token ' + res.output.token);
});

test('lastsSeconds when the answer does not say (a 24-hour token)', async function() {
  var res = await runAction(tokenStep, { loginUrl: base + '/api/plain-login', tokenPath: 'access_token', lastsSeconds: 86400 });
  assert.equal(res.status, 'success', res.error && res.error.message);
  var left = Date.parse(res.output.expiresAt) - Date.now();
  assert.ok(left > 86000e3 && left <= 86400e3, 'about a day: ' + left);
  var none = await runAction(tokenStep, { loginUrl: base + '/api/plain-login?x=1', tokenPath: 'access_token' });
  var dflt = Date.parse(none.output.expiresAt) - Date.now();
  assert.ok(dflt > 590e3 && dflt <= 600e3, 'ten minutes when nothing says: ' + dflt);
});

test('renewed a minute early: a token that runs out within the minute is not used', async function() {
  var first = await runAction(tokenStep, login({ loginUrl: base + '/api/login?life=30' }));
  var second = await runAction(tokenStep, login({ loginUrl: base + '/api/login?life=30' }));
  // 30 s life: kept at most 15 s (half), so the next call within it reuses...
  assert.equal(first.output.token, second.output.token);
  var shortLived = await runAction(tokenStep, login({ loginUrl: base + '/api/login?life=1' }));
  await new Promise(function(r) { setTimeout(r, 600); });
  var again = await runAction(tokenStep, login({ loginUrl: base + '/api/login?life=1' }));
  assert.notEqual(shortLived.output.token, again.output.token, 'past half its life it is renewed');
});

test('an API request with the token; a 401 signs in again and the call goes through', async function() {
  var got = (await runAction(tokenStep, login())).output;
  var ok = await runAction(httpStep, { path: base + '/api/rates', signInWith: got });
  assert.equal(ok.status, 'success', ok.error && ok.error.message);
  assert.equal(ok.output.body.rates[0].price, 50);
  live.delete(got.token);                       // the API revokes it
  var before = logins;
  var after = await runAction(httpStep, { path: base + '/api/rates', signInWith: got });
  assert.equal(after.status, 'success', after.error && after.error.message);
  assert.equal(logins, before + 1, 'signed in once more');
  assert.notEqual(after.output.body.as, 'Bearer ' + got.token);
});

test('a refresh token renews it; refused, it signs in from scratch', async function() {
  var def = login({ refreshUrl: base + '/api/refresh', refreshTokenPath: 'refresh' });
  var got = (await runAction(tokenStep, def)).output;
  live.delete(got.token);
  var beforeLogins = logins, beforeRefreshes = refreshes;
  var renewed = await runAction(httpStep, { path: base + '/api/rates', signInWith: got });
  assert.equal(renewed.status, 'success', renewed.error && renewed.error.message);
  assert.equal(refreshes, beforeRefreshes + 1, 'renewed with the refresh token');
  assert.equal(logins, beforeLogins, 'not with the password');
  assert.match(renewed.output.body.as, /ref-/);

  // The refresh token stops working: a full sign-in instead.
  live.clear();
  refuseRefresh = true;
  var fresh = await runAction(httpStep, { path: base + '/api/rates', signInWith: got });
  assert.equal(fresh.status, 'success', fresh.error && fresh.error.message);
  assert.equal(logins, beforeLogins + 1);
});

test('the token goes only to the API it was got for', async function() {
  var got = (await runAction(tokenStep, login())).output;
  var res = await runAction(httpStep, { path: 'https://elsewhere.example/steal', signInWith: got });
  assert.equal(res.status, 'failed');
  assert.equal(res.error.code, 'TOKEN_NOT_FOR_URL');
  var forApi = (await runAction(tokenStep, login({ apiBaseUrl: 'https://api.example.com/v1' }))).output;
  assert.equal(forApi.origin, 'https://api.example.com');
  var wrong = await runAction(httpStep, { path: base + '/api/rates', signInWith: forApi });
  assert.equal(wrong.error.code, 'TOKEN_NOT_FOR_URL');
});

test('a wrong password, or no token where it was said to be, fails with why — without the password', async function() {
  var bad = await runAction(tokenStep, login({ body: { username: 'ops', password: 'nope' } }));
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error.code, 'SIGN_IN_FAILED');
  assert.match(bad.error.message, /401/);
  assert.ok(!bad.error.message.includes('nope'));
  var noToken = await runAction(tokenStep, login({ tokenPath: 'data.nothing' }));
  assert.match(noToken.error.message, /no token in the answer at "data\.nothing"/);
  var notUrl = await runAction(tokenStep, login({ loginUrl: '/api/login' }));
  assert.equal(notUrl.error.code, 'URL_REQUIRED');
});

test('kept apart per tenant: the same login in two companies signs in twice', async function() {
  db.registerMTs && db.registerMTs([{ key: 'mtId1' }]);
  var before = logins;
  var a = await db.runWithMt({ mtId1: 'company-a' }, function() { return runAction(tokenStep, login({ loginUrl: base + '/api/login?t=1' })); });
  var b = await db.runWithMt({ mtId1: 'company-b' }, function() { return runAction(tokenStep, login({ loginUrl: base + '/api/login?t=1' })); });
  var a2 = await db.runWithMt({ mtId1: 'company-a' }, function() { return runAction(tokenStep, login({ loginUrl: base + '/api/login?t=1' })); });
  assert.notEqual(a.output.token, b.output.token);
  assert.notEqual(a.output.ref, b.output.ref);
  assert.equal(a.output.token, a2.output.token);
  assert.equal(logins, before + 2);
});

test('a stop ends the sign-in at once; no answer in time says so', async function() {
  var ctrl = new AbortController();
  var started = Date.now();
  setTimeout(function() { ctrl.abort(); }, 100);
  var stopped = await runAction(tokenStep, { loginUrl: base + '/api/slow', tokenPath: 'x' }, { system: { signal: ctrl.signal } });
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.error.code, 'STOPPED');
  assert.ok(Date.now() - started < 1500);
  var late = await runAction(tokenStep, { loginUrl: base + '/api/slow', tokenPath: 'x', timeoutMs: 1000 });
  assert.equal(late.error.code, 'UNREACHABLE');
  assert.match(late.error.message, /no answer within 1000 ms/);
});

// ── kept in Redis: shared by another process, sealed ──────────────────────
var redisUp = (function() {
  try { return execFileSync('redis-cli', ['ping'], { encoding: 'utf8', timeout: 2000 }).trim() === 'PONG'; } catch (e) { return false; }
})();

test('with XEPLR_RUNS_STORE=redis another process uses the same token, and Redis holds it sealed', { skip: redisUp ? false : 'no Redis on this machine' }, async function() {
  var env = { XEPLR_RUNS_STORE: 'redis', ENCRYPTION_KEY: 'test-key-for-tokens', REDIS_PREFIX: 'xactions-test-' + process.pid + ':' };
  var saved = {};
  Object.keys(env).forEach(function(k) { saved[k] = process.env[k]; process.env[k] = env[k]; });
  try {
    var url = base + '/api/login?redis=' + Date.now();
    var mine = await runAction(tokenStep, login({ loginUrl: url }));
    assert.equal(mine.status, 'success', mine.error && mine.error.message);
    var before = logins;
    // A second process, the same login and tenant: no second sign-in.
    var script = "require('" + path.join(__dirname, 'setup-data-dir.cjs').replace(/\\/g, '/') + "');" +
      "var { runAction } = require('" + path.join(__dirname, '../lib/runner').replace(/\\/g, '/') + "');" +
      "runAction(require('" + path.join(__dirname, '../lib/builtins/get-access-token').replace(/\\/g, '/') + "'), " +
      JSON.stringify(login({ loginUrl: url })) + ").then(function(r){ process.stdout.write(JSON.stringify(r.output || r.error)); process.exit(0); });";
    var other = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { XEPLR_DATA_DIR: process.env.XEPLR_DATA_DIR }), encoding: 'utf8', timeout: 20000 }));
    assert.equal(other.token, mine.output.token, 'the other process got the kept token');
    assert.equal(logins, before, 'and did not sign in');
    // Sealed: neither the token nor the password is readable in Redis.
    var keys = execFileSync('redis-cli', ['--scan', '--pattern', env.REDIS_PREFIX + 'xtokens:v1:*'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    assert.ok(keys.length >= 1, 'kept in Redis');
    var raw = execFileSync('redis-cli', ['get', keys[0]], { encoding: 'utf8' });
    assert.ok(!raw.includes(mine.output.token) && !raw.includes('s3cret'), 'sealed in Redis');
    var ttl = Number(execFileSync('redis-cli', ['ttl', keys[0]], { encoding: 'utf8' }).trim());
    assert.ok(ttl > 0, 'kept only until it runs out');
    keys.forEach(function(k) { execFileSync('redis-cli', ['del', k]); });
  } finally {
    Object.keys(env).forEach(function(k) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    await require('@xeplr/utils/lib/cache').disconnectCache();
  }
});
