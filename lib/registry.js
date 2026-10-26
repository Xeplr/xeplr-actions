// In-memory registry of actions. Consuming apps call register(...) at
// startup; the runner and any UI look actions up by name at run time.
//
// Definition shape:
//   {
//     name         : string     — required (unless passed as first arg)
//     description  : string     — human-readable
//     inputSchema  : array      — [{name,type,required,default,description,order}]
//     outputSchema : array?     — optional; documents what the action returns
//     requires     : string[]?  — peer-dep module names checked at register time
//     execute      : function   — async ({ input, system }) => output
//     event        : string?    — a SCREEN FUNCTION, not a step: the event it
//                                 is written for ('beforeSave', 'decide', …).
//                                 Called with that event's own context instead
//                                 of { input, system } — see the README.
//   }
//
// One registry for both, because one app registers both and the two readers
// (a screen's events, a workflow's arrows and steps) live in one process. What
// an `event` means is the reader's business: this package only keeps it, and
// lists it, so a picker can offer each event only the functions written for it.
//
// Two call forms:
//   register(name, def)      → traditional
//   register(def)            → module-export style: `def.name` is used

var { ActionMissingDependencyError } = require('./errors');

var _actions = new Map();

function register(nameOrDef, def) {
  var action;
  if (typeof nameOrDef === 'object' && nameOrDef) {
    action = nameOrDef;
  } else {
    action = Object.assign({ name: nameOrDef }, def || {});
  }

  if (typeof action.name !== 'string' || !action.name) {
    throw new Error('register: action must have a non-empty `name`');
  }
  if (typeof action.execute !== 'function') {
    throw new Error('register: action "' + action.name + '" must have an `execute` function');
  }
  if (action.event !== undefined && (typeof action.event !== 'string' || !action.event.trim())) {
    throw new Error('register: action "' + action.name + '" has an `event` that is not a name — e.g. "beforeSave"');
  }

  // Sanity-check peer deps.
  if (Array.isArray(action.requires)) {
    for (var i = 0; i < action.requires.length; i++) {
      var dep = action.requires[i];
      try { require.resolve(dep); }
      catch (_) { throw new ActionMissingDependencyError(action.name, dep); }
    }
  }

  _actions.set(action.name, {
    description:  action.description || '',
    inputSchema:  Array.isArray(action.inputSchema) ? action.inputSchema : [],
    outputSchema: action.outputSchema || null,
    requires:     Array.isArray(action.requires) ? action.requires.slice() : [],
    event:        action.event || null,
    execute:      action.execute
  });
}

function get(name) { return _actions.get(name); }
function has(name) { return _actions.has(name); }

// Serializable list — suitable for /actions HTTP endpoint response.
function list() {
  var out = [];
  _actions.forEach(function(def, name) {
    out.push({
      name: name,
      description: def.description,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      requires: def.requires,
      event: def.event
    });
  });
  return out;
}

function clear() { _actions.clear(); }

module.exports = { register: register, get: get, has: has, list: list, clear: clear };
