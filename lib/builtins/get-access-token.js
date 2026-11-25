// get-access-token action — sign in to an API once, hand the next steps a token.
//
// The first step of most API work: send a login (a username and a password, or
// a client id and secret) and keep the token the answer holds. A fixed form,
// so nobody writes a request just to log in:
//
//   loginUrl        where to sign in                 https://track.example.com/api/login
//   body            what to send (sealed by the host: it holds the password)
//   tokenPath       where the token is in the answer   data.token
//   expiresInPath   how long it lasts, in seconds      data.expires_in      (optional)
//   lastsSeconds    when the answer does not say       86400 for a 24 h token (optional)
//   refreshUrl + refreshTokenPath   renew with a refresh token instead of the password
//   header / prefix how it is sent back                Authorization / Bearer
//   apiBaseUrl      the API the token is for (default: the sign-in's own address)
//
// Output: { token, expiresAt, header, prefix, value, origin, ref } — never the
// answer, never the password. An "API request" step takes it as `signInWith`
// and adds `header: value` itself; it renews the token from `ref` when it runs
// out or the API answers 401, from any process (lib/signIn.js keeps it).
//
// IN A WORKFLOW, THE LOGIN IS A SAVED CONNECTION (`connectionInfoId`, an API
// connection signing in by "login call first" or OAuth2), created from the
// step's own picker: a step's inputs are recorded on every run, so a password
// typed into the step would be in the run's history. The host resolves the id
// to `connection` only for the call (resolveConnections). The plain fields
// (loginUrl, body, …) are for scripts and tests; a form leaves them out
// (`hidden`) unless one is already set.
//
// The same sign-in code a saved connection's "login call first" uses
// (lib/signIn.js): one copy.

var signIn = require('../signIn');

function originOf(address, what) {
  try {
    var u = new URL(String(address));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http');
    return u.origin;
  } catch (e) {
    throw signIn.signInError(what + ' must be a whole address (https://…), not "' + address + '".', 'URL_REQUIRED');
  }
}

module.exports = {
  name: 'get-access-token',
  description: 'Sign in to an API and keep the token: a login address, what to send, and where the token is in the answer. ' +
               'Returns { token, expiresAt, header, value } for the next "API request" steps; renewed when it runs out.',
  requires: [],
  inputSchema: [
    { name: 'connectionInfoId', type: 'string', order: 0, optionsFrom: 'apis', label: 'Sign in with',
      description: 'A saved API connection that signs in by a login call or OAuth2 — pick one, or make one here. Its password is kept sealed.' },
    { name: 'connection', type: 'object', order: 0.5, system: true,
      description: 'Filled from the saved connection: { baseUrl, auth }.' },
    { name: 'loginUrl', type: 'string', order: 1, hidden: true, label: 'Sign-in address',
      description: 'Where to sign in, e.g. https://track.example.com/api/login.' },
    { name: 'method', type: 'string', default: 'POST', order: 2, hidden: true, options: ['POST', 'GET', 'PUT'], label: 'Method',
      description: 'Almost always POST.' },
    { name: 'body', type: 'object', order: 3, hidden: true, secret: true, label: 'What to send',
      description: 'The login, e.g. { "username": "…", "password": "…" }. Kept sealed: never shown again, never in a run\'s history.' },
    { name: 'bodyType', type: 'string', default: 'json', order: 4, hidden: true, options: ['json', 'form'], label: 'Sent as',
      description: 'JSON, or a form (application/x-www-form-urlencoded).' },
    { name: 'tokenPath', type: 'string', default: 'token', order: 5, hidden: true, label: 'Token in the answer at',
      description: 'Where the token is in the answer, e.g. data.token or access_token.' },
    { name: 'expiresInPath', type: 'string', order: 6, hidden: true, label: 'Seconds it lasts, at',
      description: 'Where the answer says how long the token lasts, e.g. expires_in. Renewed a minute before.' },
    { name: 'lastsSeconds', type: 'number', order: 7, hidden: true, label: 'Lasts (seconds)',
      description: 'How long the token lasts when the answer does not say, e.g. 86400 for 24 hours. Default 10 minutes.' },
    { name: 'header', type: 'string', placeholder: 'Authorization', order: 8, group: 'How it is sent', label: 'Header',
      description: 'The header the token goes in on each call.' },
    { name: 'prefix', type: 'string', placeholder: 'Bearer', order: 9, group: 'How it is sent', label: 'Before the token',
      description: 'What goes before the token: Bearer, Token, or nothing.' },
    { name: 'apiBaseUrl', type: 'string', order: 10, hidden: true, group: 'How it is sent', label: 'For the API at',
      description: 'The API the token is for, when it is not on the sign-in address. The token is sent nowhere else.' },
    { name: 'refreshUrl', type: 'string', order: 11, hidden: true, group: 'Renewing', label: 'Refresh address',
      description: 'Where a refresh token renews it (often the sign-in address). Without it, it signs in again.' },
    { name: 'refreshTokenPath', type: 'string', order: 12, hidden: true, group: 'Renewing', label: 'Refresh token in the answer at',
      description: 'Where the refresh token is in the answer, e.g. refresh_token.' },
    { name: 'timeoutMs', type: 'number', default: 30000, order: 13, group: 'Advanced',
      description: 'How long to wait for the sign-in to answer.' }
  ],
  outputSchema: [
    { name: 'token', type: 'string', secret: true, description: 'The token.' },
    { name: 'expiresAt', type: 'string', description: 'When it runs out (ISO time); renewed before then.' },
    { name: 'header', type: 'string', description: 'The header it goes in, e.g. Authorization.' },
    { name: 'prefix', type: 'string', description: 'What goes before it, e.g. Bearer.' },
    { name: 'value', type: 'string', secret: true, description: 'The whole header value, e.g. "Bearer eyJ…".' },
    { name: 'origin', type: 'string', description: 'The only address the token is sent to.' },
    { name: 'ref', type: 'string', description: 'How an API request step renews it.' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var system = ctx.system || {};
    if (input.connectionInfoId && !input.connection) throw signIn.signInError('The saved connection was not resolved.', 'CONNECTION_NOT_FOUND');
    var def, origin, header, prefix;
    if (input.connection) {
      var conn = input.connection;
      var kind = conn.auth && conn.auth.type;
      if (kind !== 'login' && kind !== 'oauth2') {
        throw signIn.signInError('"Sign in with" must be a connection that signs in by a login call or OAuth2, not "' + (kind || 'none') + '".', 'AUTH_UNKNOWN');
      }
      def = signIn.fromConnection(conn);
      origin = originOf(input.apiBaseUrl || conn.baseUrl, 'The connection\'s address');
      header = input.header || conn.auth.header || 'Authorization';
      prefix = input.prefix !== undefined && input.prefix !== null ? input.prefix : (conn.auth.prefix !== undefined ? conn.auth.prefix : 'Bearer');
    } else {
      if (!input.loginUrl) throw signIn.signInError('Pick a saved sign-in ("Sign in with"), or give a sign-in address.', 'URL_REQUIRED');
      var loginOrigin = originOf(input.loginUrl, 'The sign-in address');
      origin = input.apiBaseUrl ? originOf(input.apiBaseUrl, '"For the API at"') : loginOrigin;
      def = {
        kind: 'login',
        url: String(input.loginUrl),
        method: String(input.method || 'POST').toUpperCase(),
        bodyType: input.bodyType === 'form' ? 'form' : 'json',
        body: input.body,
        tokenPath: input.tokenPath || 'token'
      };
      if (input.expiresInPath) def.expiresInPath = input.expiresInPath;
      if (Number(input.lastsSeconds) > 0) def.lastsSeconds = Number(input.lastsSeconds);
      if (input.refreshUrl) def.refreshUrl = String(input.refreshUrl);
      if (input.refreshTokenPath) def.refreshTokenPath = input.refreshTokenPath;
      header = input.header || 'Authorization';
      prefix = input.prefix;
    }
    prefix = prefix === undefined || prefix === null ? 'Bearer' : String(prefix).trim();

    var got = await signIn.tokenFor(def, { timeoutMs: Math.max(1000, Number(input.timeoutMs) || 30000), signal: system.signal });
    return {
      token: got.token,
      expiresAt: got.expiresAt,
      header: header,
      prefix: prefix,
      value: prefix ? prefix + ' ' + got.token : got.token,
      origin: origin,
      ref: got.key
    };
  }
};
