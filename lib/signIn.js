// SIGNING IN TO AN API — one copy, used by http-request (a saved connection's
// `login` / `oauth2`) and by the get-access-token step.
//
// A sign-in is described by a DEFINITION:
//
//   { kind: 'login', url, method?, bodyType?: 'json' | 'form', body?, tokenPath,
//     expiresInPath?, lastsSeconds?, refreshUrl?, refreshTokenPath? }
//   { kind: 'oauth2', url (the token address), clientId, clientSecret, scope?, audience?,
//     expiresInPath? ('expires_in'), lastsSeconds?, refreshTokenPath? }
//
// and gives a token, kept until it runs out:
//
//   - from the answer (expiresInPath), a minute early;
//   - else from lastsSeconds (a Shopify-style 24 h token: 86400);
//   - else 10 minutes.
//
// A 401 on a call throws the kept token away (forget) and the caller signs in
// again once. With refreshUrl + refreshTokenPath, a token that ran out is
// renewed with its refresh token first; refused, it signs in from scratch.
//
// WHERE TOKENS ARE KEPT. XEPLR_RUNS_STORE=redis (the setting the app already
// has for runs shared across processes) keeps them in Redis through
// @xeplr/utils' cache client — shared by every process and kept across
// restarts — SEALED with ENCRYPTION_KEY, so a token or a password is never in
// Redis in the clear. Without that setting, or without ENCRYPTION_KEY, or when
// Redis cannot be reached: this process's memory, as before. Nothing new to
// set.
//
// NEVER SHARED ACROSS TENANTS: the key is a hash of the definition AND the
// application and tenant the work runs as (@xeplr/db), so two companies with
// the same login text still sign in separately.

var crypto = require('crypto');

var TOKEN_DEFAULT_MS = 10 * 60 * 1000;
var EARLY_MS = 60 * 1000;
// A sign-in is KEPT LONGER THAN ITS TOKEN: the definition (sealed) and any
// refresh token stay this long, so a later step can sign in again after the
// token ran out or got a 401. The token itself is used only until `until`.
// The API decides whether a refresh token still works; refused, a full sign-in.
var KEEP_SECONDS = 30 * 24 * 60 * 60;
var PREFIX = 'xtokens:v1:';

var memory = new Map();   // key → { entry, until }

function signInError(message, code, extra) {
  var err = new Error(message);
  err.code = code;
  Object.assign(err, extra || {});
  return err;
}

/** A value at a dotted path: 'data.token' → obj.data.token; 'items.0.id' too. */
function at(obj, path) {
  return String(path || '').split('.').filter(Boolean).reduce(function(o, k) { return o == null ? undefined : o[k]; }, obj);
}

function tenantOf() {
  try {
    var db = require('@xeplr/db');
    var mt = (db.getMtContext && db.getMtContext()) || {};
    var app = db.getApplicationId ? db.getApplicationId() : null;
    return [app || '', mt.mtId1 || '', mt.mtId2 || '', mt.mtId3 || '', mt.mtId4 || ''].join('|');
  } catch (e) {
    return '';
  }
}

/** The key a definition's token is kept under: never the same for two tenants. */
function keyOf(def) {
  return crypto.createHash('sha256').update(JSON.stringify([tenantOf(), def])).digest('hex');
}

// ── the store ──────────────────────────────────────────────────────────────

function redisClient() {
  if (String(process.env.XEPLR_RUNS_STORE || '').trim().toLowerCase() !== 'redis') return null;
  if (!process.env.ENCRYPTION_KEY) return null;
  try { return require('@xeplr/utils/lib/cache').getClient(); } catch (e) { return null; }
}

async function seal(value) {
  var { encrypt } = require('@xeplr/utils/isomorphic/crypto');
  return encrypt(JSON.stringify(value), process.env.ENCRYPTION_KEY);
}

async function unseal(text) {
  var { decrypt } = require('@xeplr/utils/isomorphic/crypto');
  return JSON.parse(await decrypt(text, process.env.ENCRYPTION_KEY));
}

/** How long a Redis call may take before the memory answer is used instead. */
function quick(promise) {
  var timer;
  return Promise.race([
    promise,
    new Promise(function(resolve, reject) { timer = setTimeout(function() { reject(new Error('Redis did not answer')); }, 1500); if (timer.unref) timer.unref(); })
  ]).finally(function() { clearTimeout(timer); });
}

async function load(key) {
  var c = redisClient();
  if (c) {
    try {
      var raw = await quick(c.get(PREFIX + key));
      if (raw) return await unseal(raw);
      return null;
    } catch (e) {
      console.warn('[actions] token store: ' + e.message + ' — kept in this process instead');
    }
  }
  var m = memory.get(key);
  if (!m) return null;
  if (m.until < Date.now()) { memory.delete(key); return null; }
  return m.entry;
}

async function save(key, entry, seconds) {
  var c = redisClient();
  if (c) {
    try {
      await quick(c.set(PREFIX + key, await seal(entry), 'EX', Math.max(1, Math.ceil(seconds))));
      return;
    } catch (e) {
      console.warn('[actions] token store: ' + e.message + ' — kept in this process instead');
    }
  }
  memory.set(key, { entry: entry, until: Date.now() + seconds * 1000 });
}

// ── calls ──────────────────────────────────────────────────────────────────

/** fetch with a time limit and the run's stop switch. */
async function timed(url, init, timeoutMs, signal) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  if (timer.unref) timer.unref();
  var onStop = function() { controller.abort(); };
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onStop, { once: true });
  }
  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } catch (err) {
    if (signal && signal.aborted) throw signInError('Stopped.', 'STOPPED');
    var why = err.name === 'AbortError' ? 'no answer within ' + timeoutMs + ' ms' : (err.cause && err.cause.code) || err.message;
    throw signInError('Could not reach ' + String(url).split('?')[0] + ': ' + why + '.', 'UNREACHABLE', { transient: true });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onStop);
  }
}

async function readBody(res) {
  var text = await res.text();
  var type = res.headers.get('content-type') || '';
  if (/json/i.test(type) || /^\s*[\[{]/.test(text)) {
    try { return JSON.parse(text); } catch (e) { /* not JSON after all */ }
  }
  return text;
}

function encoded(body, bodyType) {
  if (body === undefined || body === null || body === '') return { body: undefined, type: undefined };
  if (bodyType === 'form') {
    var form = new URLSearchParams();
    Object.keys(body || {}).forEach(function(k) { if (body[k] !== undefined && body[k] !== null) form.set(k, String(body[k])); });
    return { body: form.toString(), type: 'application/x-www-form-urlencoded' };
  }
  return { body: typeof body === 'string' ? body : JSON.stringify(body), type: 'application/json' };
}

/** Where the token, its lifetime and its refresh token sit in this kind of answer. */
function pathsOf(def) {
  if (def.kind === 'oauth2') {
    return { token: def.tokenPath || 'access_token', expires: def.expiresInPath || 'expires_in', refresh: def.refreshTokenPath || 'refresh_token' };
  }
  return { token: def.tokenPath || 'token', expires: def.expiresInPath, refresh: def.refreshTokenPath };
}

/** One call to the sign-in address (or the refresh address), its answer as an entry. */
async function ask(def, url, body, bodyType, opts) {
  var sent = encoded(body, bodyType);
  var headers = { accept: 'application/json' };
  if (sent.type) headers['content-type'] = sent.type;
  var res = await timed(url, { method: def.method || 'POST', headers: headers, body: sent.body }, opts.timeoutMs, opts.signal);
  var answer = await readBody(res);
  var paths = pathsOf(def);
  var token = at(answer, paths.token);
  if (!res.ok || token === undefined || token === null || token === '') {
    throw signInError('Signing in at ' + String(url).split('?')[0] + ' failed: ' + res.status +
      (token ? '' : ', and no token in the answer at "' + paths.token + '"') + '.', 'SIGN_IN_FAILED', { status: res.status });
  }
  var expiresIn = paths.expires ? Number(at(answer, paths.expires)) : NaN;
  var lifeMs = expiresIn > 0 ? expiresIn * 1000
    : Number(def.lastsSeconds) > 0 ? Number(def.lastsSeconds) * 1000
      : TOKEN_DEFAULT_MS;
  var refresh = paths.refresh ? at(answer, paths.refresh) : undefined;
  return {
    token: String(token),
    // A minute early, so a token never runs out mid-call (never below zero).
    until: Date.now() + Math.max(0, lifeMs - Math.min(EARLY_MS, lifeMs / 2)),
    expiresAt: new Date(Date.now() + lifeMs).toISOString(),
    refreshToken: refresh === undefined || refresh === null ? null : String(refresh)
  };
}

function signInBody(def) {
  if (def.kind === 'oauth2') {
    var b = { grant_type: 'client_credentials', client_id: def.clientId || '', client_secret: def.clientSecret || '' };
    if (def.scope) b.scope = def.scope;
    if (def.audience) b.audience = def.audience;
    return { body: b, bodyType: 'form' };
  }
  return { body: def.body, bodyType: def.bodyType === 'form' ? 'form' : 'json' };
}

function refreshBody(def, refreshToken) {
  var b = { grant_type: 'refresh_token', refresh_token: refreshToken };
  if (def.kind === 'oauth2') {
    b.client_id = def.clientId || '';
    b.client_secret = def.clientSecret || '';
    return { body: b, bodyType: 'form' };
  }
  return { body: b, bodyType: def.bodyType === 'form' ? 'form' : 'json' };
}

function checkDef(def) {
  if (!def || (def.kind !== 'login' && def.kind !== 'oauth2')) throw signInError('A sign-in is a login call or OAuth2.', 'AUTH_UNKNOWN');
  if (!def.url || !/^https?:\/\//i.test(String(def.url))) throw signInError('The sign-in address must be a whole address (https://…).', 'URL_REQUIRED');
}

/**
 * The token for a definition: the kept one while it lasts, else renewed with
 * the refresh token, else a fresh sign-in.
 * opts: { timeoutMs = 30000, signal, fresh }  → { token, expiresAt, key }
 */
async function tokenFor(def, opts) {
  checkDef(def);
  var o = Object.assign({ timeoutMs: 30000 }, opts || {});
  var key = keyOf(def);
  var kept = o.fresh ? null : await load(key);
  if (kept && kept.until > Date.now()) return { token: kept.token, expiresAt: kept.expiresAt, key: key };

  var entry = null;
  var refreshToken = kept && kept.refreshToken;
  // A login renews only where it says (refreshUrl); OAuth2 at its token address.
  var canRefresh = Boolean(refreshToken) && (def.kind === 'oauth2' || Boolean(def.refreshUrl));
  if (canRefresh) {
    var rb = refreshBody(def, refreshToken);
    try {
      entry = await ask(def, def.refreshUrl || def.url, rb.body, rb.bodyType, o);
      // An API that does not hand a new refresh token keeps the old one working.
      if (!entry.refreshToken) entry.refreshToken = refreshToken;
    } catch (e) {
      if (e.code === 'STOPPED') throw e;
      entry = null;   // refused: sign in from scratch
    }
  }
  if (!entry) {
    var sb = signInBody(def);
    entry = await ask(def, def.url, sb.body, sb.bodyType, o);
  }
  // Kept for other processes: the definition goes with it, so a call that
  // gets a 401 can sign in again from any process.
  entry.def = def;
  await save(key, entry, KEEP_SECONDS);
  return { token: entry.token, expiresAt: entry.expiresAt, key: key };
}

/** The definition kept with a key — how a later step signs in again after a 401. */
async function definitionOf(key) {
  var kept = await load(key);
  return kept ? kept.def : null;
}

/**
 * A token the API no longer takes: the token is no longer used; the sign-in
 * (and a refresh token) stays, so the next tokenFor renews from it.
 */
async function forget(def) {
  var key = keyOf(def);
  var kept = await load(key);
  if (kept) await save(key, Object.assign({}, kept, { until: 0 }), KEEP_SECONDS);
}

/** A saved connection's `auth` as a sign-in definition (http-request). */
function fromConnection(conn) {
  var auth = (conn && conn.auth) || {};
  if (auth.type === 'oauth2') {
    return { kind: 'oauth2', url: auth.tokenUrl, clientId: auth.clientId, clientSecret: auth.clientSecret, scope: auth.scope, audience: auth.audience };
  }
  var base = String((conn && conn.baseUrl) || '').replace(/\/+$/, '');
  var url = /^https?:\/\//i.test(auth.url || '') ? auth.url : base + '/' + String(auth.url || '').replace(/^\/+/, '');
  var def = { kind: 'login', url: url, method: auth.method || 'POST', body: auth.body, tokenPath: auth.tokenPath || 'token' };
  if (auth.bodyType) def.bodyType = auth.bodyType;
  if (auth.expiresInPath) def.expiresInPath = auth.expiresInPath;
  if (auth.lastsSeconds) def.lastsSeconds = auth.lastsSeconds;
  if (auth.refreshUrl) def.refreshUrl = auth.refreshUrl;
  if (auth.refreshTokenPath) def.refreshTokenPath = auth.refreshTokenPath;
  return def;
}

module.exports = {
  tokenFor: tokenFor,
  forget: forget,
  definitionOf: definitionOf,
  fromConnection: fromConnection,
  timed: timed,
  readBody: readBody,
  at: at,
  signInError: signInError,
  // For tests: forget every token kept in this process.
  _forgetAll: function() { memory = new Map(); }
};
