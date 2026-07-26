var { applySchema } = require('@xeplr/schema-handler');
var { get } = require('./registry');
var { ActionNotRegisteredError } = require('./errors');

/**
 * Safely run an action. Two call forms supported:
 *
 *   runAction({ name, input, system?, timeoutMs? })
 *       — look up a registered action by name (the Jobs / config path).
 *
 *   runAction(nameOrAction, input, opts?)
 *       — shorthand for one-off programmatic use. First arg can be a name
 *         (string) OR an action module `{ name, inputSchema, execute, ... }`.
 *         `opts` = { system, timeoutMs, metaStore }.
 *
 * Returns { status: 'success' | 'failed', output, error, durationMs }.
 * Never throws — every failure (unregistered action, validation, executor
 * exception, timeout) is captured in `error`.
 */
async function runAction(first, second, third) {
  var start = Date.now();
  var opts = normalizeArgs(first, second, third);

  var def = opts.action || get(opts.name);
  if (!def) return finish(start, 'failed', null, new ActionNotRegisteredError(opts.name));

  var input;
  try {
    input = applySchema(def.inputSchema, opts.input || {}, 'input');
  } catch (err) {
    return finish(start, 'failed', null, err);
  }

  try {
    var call = def.execute({ input: input, system: opts.system || {}, metaStore: opts.metaStore });
    var settled = (opts.timeoutMs && call && typeof call.then === 'function')
      ? withTimeout(call, opts.timeoutMs)
      : call;
    var output = await settled;
    return finish(start, 'success', output, null);
  } catch (err) {
    return finish(start, 'failed', null, err);
  }
}

// Accept either the options-object form or the shorthand (action, input, opts).
function normalizeArgs(first, second, third) {
  // Shorthand form: first arg is a string name or an action module.
  if (typeof first === 'string' || (first && typeof first.execute === 'function')) {
    var extra = third || {};
    var result = { input: second || {}, system: extra.system, timeoutMs: extra.timeoutMs, metaStore: extra.metaStore };
    if (typeof first === 'string') result.name = first;
    else                            result.action = first;
    return result;
  }
  // Options-object form.
  return first || {};
}

function finish(start, status, output, err) {
  var e = null;
  if (err) {
    e = { name: err.name || 'Error', message: err.message };
    if (err.stack) e.stack = err.stack;
    if (err.details) e.details = err.details;
    if (err.actionName) e.actionName = err.actionName;
  }
  return { status: status, output: output, error: e, durationMs: Date.now() - start };
}

function withTimeout(promise, ms) {
  return new Promise(function(resolve, reject) {
    var t = setTimeout(function() { reject(new Error('Action timed out after ' + ms + 'ms')); }, ms);
    promise.then(
      function(v) { clearTimeout(t); resolve(v); },
      function(e) { clearTimeout(t); reject(e); }
    );
  });
}

module.exports = { runAction: runAction };
