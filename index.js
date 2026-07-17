var registry = require('./lib/registry');
var runner = require('./lib/runner');
var errors = require('./lib/errors');
var builtins = require('./lib/builtins');

module.exports = {
  // Registry
  register: registry.register,
  get: registry.get,
  has: registry.has,
  list: registry.list,
  clear: registry.clear,

  // Safe invocation
  runAction: runner.runAction,

  // Errors
  ActionNotRegisteredError:     errors.ActionNotRegisteredError,
  ActionMissingDependencyError: errors.ActionMissingDependencyError,
  TransientError:               errors.TransientError,

  // Built-in actions (each module has { name, requires?, inputSchema, execute })
  // Register any subset:
  //   var { register, builtins } = require('@xeplr/actions');
  //   register(builtins.httpRequest);
  //   register(builtins.dbFetch);
  builtins: builtins
};
