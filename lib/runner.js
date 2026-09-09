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
    input = applySchema(def.inputSchema, coerceScalars(def.inputSchema, opts.input || {}), 'input');
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

/**
 * ONE VALUE WHERE A LIST WAS DECLARED MEANS A LIST OF ONE.
 *
 * Without this, an `array` field can only ever be given a literal array — and
 * that quietly breaks the thing every caller of this package is built to do,
 * which is BIND A REFERENCE. A workflow step writes `to = {params.email}`; the
 * engine interpolates that to a string; applySchema then rejects it for not
 * being an array, and the run fails on a step that reads as obviously correct.
 * Every array-typed input was unbindable, in every action, for every consumer.
 *
 * It also makes email-send's own promise true. Its schema has said "a bare
 * string is accepted and wrapped" since it was written, and nothing wrapped
 * anything — applySchema refused it before execute() ever ran.
 *
 * Deliberately NARROW:
 *
 *   - only for fields the schema declares `array`, so nothing else can be
 *     reshaped by accident;
 *   - only when the value is a scalar. An object stays an object and fails
 *     the type check as it should, because `{a:1}` is a mistake, not a
 *     one-element list;
 *   - null and undefined are left alone, so `required` still means required
 *     and a default still fills in;
 *   - '' is left alone, so an empty box does not become `['']` — a list
 *     containing one empty string is a value, and "unset" is what was meant.
 *
 * No JSON parsing here. A string that looks like JSON is the CALLER's to
 * parse: this layer cannot tell `"[1,2]"` the literal text from `[1,2]` the
 * list, and guessing would make a value's meaning depend on its punctuation.
 */
function coerceScalars(schema, input) {
  if (!Array.isArray(schema)) return input;
  var out = null;
  for (var i = 0; i < schema.length; i++) {
    var field = schema[i];
    if (!field || field.type !== 'array') continue;
    var val = input[field.name];
    if (val === undefined || val === null || val === '') continue;
    if (Array.isArray(val) || typeof val === 'object') continue;
    if (!out) out = Object.assign({}, input);
    out[field.name] = [val];
  }
  return out || input;
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
