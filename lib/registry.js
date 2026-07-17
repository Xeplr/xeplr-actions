// In-memory registry of actions. Consuming apps call register(name, def)
// at startup; the runner and any UI look actions up by name at run time.
//
// Definition shape:
//   {
//     description : string     — human-readable
//     inputSchema : array      — [{name,type,required,default,description,order}]
//     outputSchema: array?     — optional; documents what the action returns
//     execute     : function   — async ({ input, system }) => output
//   }

var _actions = new Map();

function register(name, def) {
  if (typeof name !== 'string' || !name) throw new Error('register: name must be a non-empty string');
  if (!def || typeof def.execute !== 'function') throw new Error('register: def.execute must be a function');
  _actions.set(name, {
    description:  def.description || '',
    inputSchema:  Array.isArray(def.inputSchema) ? def.inputSchema : [],
    outputSchema: def.outputSchema || null,
    execute:      def.execute
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
      outputSchema: def.outputSchema
    });
  });
  return out;
}

function clear() { _actions.clear(); }

module.exports = { register: register, get: get, has: has, list: list, clear: clear };
