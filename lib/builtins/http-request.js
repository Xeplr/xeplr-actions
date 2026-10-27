// http-request action — call another system's API.
//
// One call: a method, a path on the API, query values, headers and a body,
// and the answer back as { status, ok, body, headers }. The body is parsed
// JSON when the answer says it is JSON, else text.
//
// WHERE AND AS WHOM come from a saved connection (`connectionInfoId`), which
// the host turns into `connection` just before the call (resolveConnections):
//
//   { baseUrl: 'https://api.bank.example/v2',
//     headers?: { 'X-Tenant': 'acme' },
//     auth: { type: 'none' }
//         | { type: 'apiKey', in: 'header' | 'query', name: 'X-API-Key', value }
//         | { type: 'bearer', token }
//         | { type: 'basic', username, password }
//         | { type: 'login', url, method?, body?, tokenPath, header?, prefix?, expiresInPath? }
//         | { type: 'oauth2', tokenUrl, clientId, clientSecret, scope?, audience? } }
//
// so a workflow never holds a key or a password, and a step's recorded input
// holds only the id. Without a saved connection, `path` may be a whole
// address (a public API that needs no sign-in).
//
// A TOKEN FROM A LOGIN CALL OR OAUTH is fetched once and kept in this process
// until it runs out (or, with no expiry given, for 10 minutes). A 401 throws
// it away and the call is tried once more with a fresh one.
//
// RETRIES: a network failure, 429 or 5xx is tried again (`retries`, default
// 2), waiting longer each time, or as long as Retry-After asks. A 4xx other
// than 401/429 is the API refusing the request and is not retried.
//
// A STATUS THAT IS NOT 2xx fails the step (`failOnError`, default true),
// saying the status and the start of the answer. Off: the step succeeds and
// the arrows can branch on output.status.

var crypto = require('crypto');

var TOKEN_DEFAULT_MS = 10 * 60 * 1000;
var tokens = {};   // key → { value, until }

function httpError(message, code, extra) {
  var err = new Error(message);
  err.code = code;
  Object.assign(err, extra || {});
  return err;
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

/** A value at a dotted path in an object: 'data.token' → obj.data.token. */
function at(obj, path) {
  return String(path || '').split('.').filter(Boolean).reduce(function(o, k) { return o == null ? undefined : o[k]; }, obj);
}

/** The full address: a path is joined to the connection's base; a whole URL must stay on it. */
function addressOf(conn, input) {
  var raw = String(input.path || '').trim();
  var base = conn && conn.baseUrl ? String(conn.baseUrl).replace(/\/+$/, '') : '';
  var url;
  if (/^https?:\/\//i.test(raw)) {
    url = new URL(raw);
    // A saved connection signs in to ITS address only: a whole URL elsewhere
    // would send the key to whoever is there.
    if (base && url.origin !== new URL(base).origin) {
      throw httpError('"' + raw + '" is not on this connection\'s address (' + base + '). Give a path, e.g. /statements.', 'URL_NOT_ON_CONNECTION');
    }
  } else {
    if (!base) throw httpError('Give a whole address (https://…), or pick a saved connection and give a path.', 'URL_REQUIRED');
    url = new URL(base + (raw ? '/' + raw.replace(/^\/+/, '') : ''));
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw httpError('Only http and https addresses.', 'URL_REQUIRED');
  Object.keys(input.query || {}).forEach(function(k) {
    var v = input.query[k];
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  });
  return url;
}

/** A body as fetch sends it, and its content type. */
function bodyOf(input) {
  if (input.body === undefined || input.body === null || input.body === '') return { body: undefined };
  var kind = input.bodyType || (typeof input.body === 'string' ? 'text' : 'json');
  if (kind === 'json') return { body: typeof input.body === 'string' ? input.body : JSON.stringify(input.body), type: 'application/json' };
  if (kind === 'form') {
    var form = new URLSearchParams();
    Object.keys(input.body || {}).forEach(function(k) { form.set(k, String(input.body[k])); });
    return { body: form.toString(), type: 'application/x-www-form-urlencoded' };
  }
  return { body: String(input.body), type: 'text/plain' };
}

async function readBody(res) {
  var text = await res.text();
  var type = res.headers.get('content-type') || '';
  if (/json/i.test(type) || /^\s*[\[{]/.test(text)) {
    try { return JSON.parse(text); } catch (e) { /* not JSON after all */ }
  }
  return text;
}

function cacheKey(conn) {
  return crypto.createHash('sha256').update(JSON.stringify([conn.baseUrl, conn.auth])).digest('hex');
}

/** A token from the connection's login call or OAuth, kept until it runs out. */
async function tokenFor(conn, timeoutMs) {
  var key = cacheKey(conn);
  var kept = tokens[key];
  if (kept && kept.until > Date.now()) return kept.value;
  var auth = conn.auth;
  var res, answer, token, expiresIn;
  if (auth.type === 'oauth2') {
    var form = new URLSearchParams({ grant_type: 'client_credentials', client_id: auth.clientId || '', client_secret: auth.clientSecret || '' });
    if (auth.scope) form.set('scope', auth.scope);
    if (auth.audience) form.set('audience', auth.audience);
    res = await timed(auth.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() }, timeoutMs);
    answer = await readBody(res);
    token = answer && answer.access_token;
    expiresIn = answer && answer.expires_in;
  } else {
    var loginUrl = /^https?:\/\//i.test(auth.url || '') ? auth.url : String(conn.baseUrl || '').replace(/\/+$/, '') + '/' + String(auth.url || '').replace(/^\/+/, '');
    var b = auth.body === undefined ? undefined : (typeof auth.body === 'string' ? auth.body : JSON.stringify(auth.body));
    res = await timed(loginUrl, { method: auth.method || 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: b }, timeoutMs);
    answer = await readBody(res);
    token = at(answer, auth.tokenPath || 'token');
    expiresIn = auth.expiresInPath ? at(answer, auth.expiresInPath) : undefined;
  }
  if (!res.ok || !token) {
    tokens[key] = undefined;
    throw httpError('Signing in to ' + (conn.baseUrl || 'the API') + ' failed: ' + res.status +
      (token ? '' : ', and no token in the answer' + (auth.type === 'login' ? ' at "' + (auth.tokenPath || 'token') + '"' : '')) + '.', 'SIGN_IN_FAILED', { status: res.status });
  }
  // A minute early, so a token never runs out mid-call.
  var lifeMs = Number(expiresIn) > 0 ? Math.max(0, Number(expiresIn) * 1000 - 60000) : TOKEN_DEFAULT_MS;
  tokens[key] = { value: String(token), until: Date.now() + lifeMs };
  return String(token);
}

async function timed(url, init, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  if (timer.unref) timer.unref();
  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } catch (err) {
    var why = err.name === 'AbortError' ? 'no answer within ' + timeoutMs + ' ms' : (err.cause && err.cause.code) || err.message;
    throw httpError('Could not reach ' + String(url).split('?')[0] + ': ' + why + '.', 'UNREACHABLE', { transient: true });
  } finally {
    clearTimeout(timer);
  }
}

/** Headers for one call: the connection's, the sign-in's, then the step's own. */
async function headersFor(conn, input, url, timeoutMs) {
  var h = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' };
  Object.assign(h, (conn && conn.headers) || {});
  var auth = (conn && conn.auth) || { type: 'none' };
  if (auth.type === 'apiKey') {
    if (auth.in === 'query') url.searchParams.set(auth.name || 'api_key', auth.value || '');
    else h[auth.name || 'X-API-Key'] = auth.value || '';
  } else if (auth.type === 'bearer') {
    h.authorization = 'Bearer ' + (auth.token || '');
  } else if (auth.type === 'basic') {
    h.authorization = 'Basic ' + Buffer.from((auth.username || '') + ':' + (auth.password || '')).toString('base64');
  } else if (auth.type === 'login' || auth.type === 'oauth2') {
    var token = await tokenFor(conn, timeoutMs);
    var name = auth.header || 'authorization';
    h[name] = (auth.prefix === undefined ? 'Bearer ' : auth.prefix) + token;
  } else if (auth.type && auth.type !== 'none') {
    throw httpError('"' + auth.type + '" is not a way of signing in. Kinds: none, apiKey, bearer, basic, login, oauth2.', 'AUTH_UNKNOWN');
  }
  Object.assign(h, input.headers || {});
  return h;
}

/** How long to wait before try `n`: Retry-After when the API says, else 1s, 2s, 4s… */
function waitFor(res, n, baseMs) {
  var after = res && res.headers && res.headers.get('retry-after');
  if (after && !isNaN(Number(after))) return Math.min(60000, Number(after) * 1000);
  return baseMs * Math.pow(2, n - 1);
}

module.exports = {
  name: 'http-request',
  description: 'Call another system\'s API: a method, a path, query values, headers and a body. ' +
               'Signs in with a saved connection. Returns { status, ok, body, headers }.',
  requires: [],
  inputSchema: [
    { name: 'connectionInfoId', type: 'string', order: 1, optionsFrom: 'apis',
      description: 'A saved API connection: its address and how to sign in. Resolved on the server.' },
    { name: 'connection', type: 'object', order: 2, system: true,
      description: 'Filled from the saved connection: { baseUrl, headers?, auth }.' },
    { name: 'method', type: 'string', default: 'GET', order: 3, options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      description: 'GET reads; POST sends something new; PUT / PATCH change; DELETE removes.' },
    { name: 'path', type: 'string', order: 4,
      description: 'Where on the API, e.g. /statements. Or a whole address (https://…) with no saved connection.' },
    { name: 'query', type: 'object', order: 5,
      description: 'Values for the address, e.g. { "from": "{trigger.window.from|date:YYYY-MM-DD}" }.' },
    { name: 'body', type: 'object', order: 6,
      description: 'What to send with POST / PUT / PATCH, e.g. { "rows": "{steps.match.output.rows}" }.' },
    { name: 'bodyType', type: 'string', default: 'json', order: 7, group: 'Advanced', options: ['json', 'form', 'text'],
      description: 'How the body is sent: json, a form, or plain text.' },
    { name: 'headers', type: 'object', order: 8, group: 'Advanced',
      description: 'Extra headers for this call. The sign-in is added from the connection.' },
    { name: 'failOnError', type: 'boolean', default: true, order: 9, group: 'Advanced',
      description: 'On: a status that is not 2xx fails the step. Off: the step succeeds and the arrows branch on output.status.' },
    { name: 'retries', type: 'number', default: 2, order: 10, group: 'Advanced',
      description: 'Tries again on a network failure, 429 or 5xx, waiting longer each time.' },
    { name: 'retryAfterMs', type: 'number', default: 1000, order: 11, group: 'Advanced',
      description: 'The first wait between tries; it doubles each time, unless the API says Retry-After.' },
    { name: 'timeoutMs', type: 'number', default: 30000, order: 12, group: 'Advanced',
      description: 'How long to wait for an answer.' }
  ],
  outputSchema: [
    { name: 'status', type: 'number', description: 'The HTTP status, e.g. 200.' },
    { name: 'ok', type: 'boolean', description: 'Whether it was 2xx.' },
    { name: 'body', type: 'object', description: 'The answer: parsed JSON, or text.' },
    { name: 'headers', type: 'object', description: 'The answer\'s content-type, and any rate-limit or paging headers.' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var conn = input.connection || null;
    if (input.connectionInfoId && !conn) throw httpError('The saved connection was not resolved.', 'CONNECTION_NOT_FOUND');
    var method = String(input.method || 'GET').toUpperCase();
    var timeoutMs = Math.max(1000, Number(input.timeoutMs) || 30000);
    var retries = Math.max(0, Math.min(10, input.retries == null ? 2 : Number(input.retries)));
    var baseWait = Math.max(0, input.retryAfterMs == null ? 1000 : Number(input.retryAfterMs));
    var sent = method === 'GET' || method === 'DELETE' ? { body: undefined } : bodyOf(input);

    var refreshed = false;
    var res;
    for (var attempt = 0; ; attempt++) {
      var url = addressOf(conn, input);
      var headers = await headersFor(conn, input, url, timeoutMs);
      if (sent.type && !Object.keys(headers).some(function(k) { return k.toLowerCase() === 'content-type'; })) headers['content-type'] = sent.type;
      try {
        res = await timed(url.toString(), { method: method, headers: headers, body: sent.body }, timeoutMs);
      } catch (err) {
        if (err.transient && attempt < retries) { await sleep(baseWait * Math.pow(2, attempt)); continue; }
        throw err;
      }
      // A kept token the API no longer takes: throw it away and sign in again, once.
      if (res.status === 401 && conn && conn.auth && (conn.auth.type === 'login' || conn.auth.type === 'oauth2') && !refreshed) {
        tokens[cacheKey(conn)] = undefined;
        refreshed = true;
        attempt--;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await res.text().catch(function() {});
        await sleep(waitFor(res, attempt + 1, baseWait));
        continue;
      }
      break;
    }

    var body = await readBody(res);
    var kept = {};
    res.headers.forEach(function(v, k) {
      if (k === 'content-type' || k === 'link' || /^x-(rate|ratelimit|total|page|next)/i.test(k) || /^ratelimit/i.test(k)) kept[k] = v;
    });
    if (!res.ok && input.failOnError !== false) {
      var said = typeof body === 'string' ? body : JSON.stringify(body);
      throw httpError(method + ' ' + url.pathname + ' answered ' + res.status + (said ? ': ' + said.slice(0, 300) : '') + '.', 'HTTP_' + res.status, { status: res.status });
    }
    return { status: res.status, ok: res.ok, body: body, headers: kept };
  },

  // For tests: forget every kept token.
  _forgetTokens: function() { tokens = {}; }
};
