var registry = require('./lib/registry');
var runner = require('./lib/runner');
var errors = require('./lib/errors');

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
  ActionNotRegisteredError: errors.ActionNotRegisteredError,
  TransientError: errors.TransientError
};
