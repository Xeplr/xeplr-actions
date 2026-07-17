class ActionNotRegisteredError extends Error {
  constructor(name) {
    super('No action registered: ' + name);
    this.name = 'ActionNotRegisteredError';
    this.actionName = name;
  }
}

// Placeholder for future retry logic. Callers (jobs, workflow) can use this
// to signal "this failure is transient, please retry me." Today no framework
// acts on it; when retry rules land, they will branch on this error class.
class TransientError extends Error {
  constructor(message, opts) {
    super(message);
    this.name = 'TransientError';
    if (opts && opts.cause) this.cause = opts.cause;
  }
}

module.exports = { ActionNotRegisteredError: ActionNotRegisteredError, TransientError: TransientError };
