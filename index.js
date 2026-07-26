var registry  = require('./lib/registry');
var runner    = require('./lib/runner');
var errors    = require('./lib/errors');
var builtins  = require('./lib/builtins');
var uploader  = require('./lib/uploader');
var streaming = require('./lib/streaming');
var dbDrivers = require('./lib/drivers/db');
var fileDrivers = require('./lib/drivers/file');
var formats   = require('./lib/formats');
var configDb  = require('./lib/uploader/attach');

module.exports = {
  // Registry
  register:      registry.register,
  get:           registry.get,
  has:           registry.has,
  list:          registry.list,
  clear:         registry.clear,

  // Safe invocation — two forms:
  //   runAction({ name, input, system?, timeoutMs? })
  //   runAction(nameOrAction, input, opts?)
  runAction:     runner.runAction,

  // Errors
  ActionNotRegisteredError:     errors.ActionNotRegisteredError,
  ActionMissingDependencyError: errors.ActionMissingDependencyError,
  TransientError:               errors.TransientError,

  // Built-in actions
  //   var { register, builtins } = require('@xeplr/actions');
  //   register(builtins.sendEmail);                    ← simple
  //   register(builtins.fileUpload({ metaKnex }));     ← factory-shaped when config is needed
  builtins:      builtins,

  // Primitives (used internally by actions and exposed for consumers writing
  // their own — e.g. a UI wizard showing inferred columns from a CSV sample
  // before actually committing to an import).
  uploader:      uploader,
  inferColumns:  uploader.inferColumns,
  streaming:     streaming,
  drivers:       { db: dbDrivers, file: fileDrivers },
  formats:       formats,

  // xeplr_configs — shared control-plane DB (import/movement metadata).
  // One call per app: attachConfig({ service }); await xcfg.ready(). See
  // lib/uploader/attach.js. configRequiredEnv spreads into the app's own
  // env.required.js, same convention as @xeplr/auth's requiredEnv.
  attachConfig:      configDb.attachConfig,
  configRequiredEnv: configDb.requiredEnv
};
