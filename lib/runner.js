var { applySchema } = require('@xeplr/schema-handler');
var { get } = require('./registry');
var { ActionNotRegisteredError } = require('./errors');

/**
 * Safely run a registered action.
 *
 *   name       — action name registered via register()
 *   input      — flat object of input values
 *   system     — free-form runtime context passed to the action
 *                (jobs pass in jobId, occurrenceId, startedAt, etc.)
 *   timeoutMs  — optional wall-clock timeout; on trip, resolves as failed
 *
 * Returns:
 *   { status: 'success' | 'failed', output, error, durationMs }
 *
 * Never throws. All failures — missing action, validation, executor
 * exception, timeout — are captured in `error`.
 */
async function runAction(opts) {
  var start = Date.now();
  opts = opts || {};

  var def = get(opts.name);
  if (!def) return finish(start, 'failed', null, new ActionNotRegisteredError(opts.name));

  var input;
  try {
    input = applySchema(def.inputSchema, opts.input || {}, 'input');
  } catch (err) {
    return finish(start, 'failed', null, err);
  }

  try {
    var call = def.execute({ input: input, system: opts.system || {} });
    var settled = (opts.timeoutMs && call && typeof call.then === 'function')
      ? withTimeout(call, opts.timeoutMs)
      : call;
    var output = await settled;
    return finish(start, 'success', output, null);
  } catch (err) {
    return finish(start, 'failed', null, err);
  }
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
