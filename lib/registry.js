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
//   }
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
      requires: def.requires
    });
  });
  return out;
}

function clear() { _actions.clear(); }

module.exports = { register: register, get: get, has: has, list: list, clear: clear };
