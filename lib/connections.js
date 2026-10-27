// SAVED CONNECTIONS: AN ID IN THE STEP, THE LOGIN ONLY IN THE CALL.
//
// An action like db-fetch takes `connection: { host, port, user, password,
// database }`. A job or a workflow step cannot store that, and a person
// cannot type it:
//
//   - The browser must never see it. A host seals credentials and decrypts
//     them only at the point of use.
//   - What a run records must never hold it. A job's inputs are snapshotted
//     on every occurrence, and a workflow step's input on every step run, so
//     one password in a definition becomes one password in a hundred rows.
//
// So the definition stores `connectionInfoId` (an id, safe everywhere), and
// the id is exchanged for the real login HERE, moments before the action is
// called, only in the object handed to that call. One copy, used by
// @xeplr/jobs and @xeplr/workflow-engine.
//
// ONE HOOK, not one per action: the host says once how an id becomes a
// connection (`resolver`), and every action taking a connection benefits.
// The convention is the field NAME:
//
//   connectionInfoId        → connection
//   sourceConnectionInfoId  → sourceConnection
//   targetConnectionInfoId  → targetConnection
//
// so an action with two connections needs no configuration to get both.

var CONNECTION_ID_SUFFIX = /ConnectionInfoId$/;

/** The field a connection id fills: connectionInfoId → connection. null for any other field. */
function connectionFieldFor(key) {
  if (key === 'connectionInfoId') return 'connection';
  if (!CONNECTION_ID_SUFFIX.test(key)) return null;
  return key.slice(0, -'ConnectionInfoId'.length) + 'Connection';
}

/**
 * Swap every *ConnectionInfoId in `inputs` for the login it names.
 *
 * Returns a NEW object: the caller's inputs are left untouched, which is what
 * keeps a run's record free of secrets.
 *
 * A MISSING RESOLUTION IS FATAL, deliberately. If a definition says "use
 * connection X" and X has been deleted, belongs to another tenant, or cannot
 * be decrypted because the key was rotated, the only safe answer is to stop.
 * Falling back to a literal `connection` sitting in the inputs would connect
 * to something the author did not ask for, and it would work. A literal
 * connection is honoured only when no id was given at all.
 *
 * Call it inside the run's tenant context: a host's saved connections are
 * usually tenant-scoped, and resolving outside one finds nothing.
 *
 * @param {object} inputs
 * @param {Function} resolver  async (id, { field, inputs }) → a login, or { dbType, connection }
 * @param {string} [who]       how the refusal names the caller ("This job", "Step fetch")
 */
async function resolveConnections(inputs, resolver, who) {
  var raw = inputs || {};
  var ids = Object.keys(raw).filter(function(k) { return connectionFieldFor(k) && raw[k]; });
  if (!ids.length) return raw;
  var name = who || 'This';

  if (typeof resolver !== 'function') {
    var none = new Error(name + ' names a saved connection (' + ids.join(', ') +
      '), but no connection resolver is configured. The host passes resolveConnection.');
    none.code = 'NO_CONNECTION_RESOLVER';
    throw none;
  }

  var out = Object.assign({}, raw);
  for (var i = 0; i < ids.length; i++) {
    var key = ids[i];
    var target = connectionFieldFor(key);

    // THE WHOLE INPUTS go to the resolver, not just the one id: a saved
    // connection is not always one id. BI's takes (connectionId, dbInfoId),
    // the server and then which database on it.
    var resolved = await resolver(raw[key], { field: key, inputs: raw });
    if (!resolved) {
      var missing = new Error('Connection "' + raw[key] + '" (' + key + ') could not be resolved: ' +
        'it may have been deleted, or belong to another company. Refusing to run ' +
        'rather than fall back to a different connection.');
      missing.code = 'CONNECTION_NOT_FOUND';
      throw missing;
    }

    // Two accepted shapes: a bare login, or { dbType, connection }. The
    // second matters: the connection already knows whether it is postgres,
    // mysql or mssql, so nobody has to choose that again.
    if (resolved.connection) {
      out[target] = resolved.connection;
      var typeField = target === 'connection' ? 'dbType' : target + 'DbType';
      if (resolved.dbType) out[typeField] = resolved.dbType;
    } else {
      out[target] = resolved;
    }

    // The id goes no further. The action was never given one to interpret.
    delete out[key];
  }
  return out;
}

module.exports = { resolveConnections: resolveConnections, connectionFieldFor: connectionFieldFor };
