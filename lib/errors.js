class ActionNotRegisteredError extends Error {
  constructor(name) {
    super('No action registered: ' + name);
    this.name = 'ActionNotRegisteredError';
    this.actionName = name;
  }
}

// Thrown at register() when a declared peer dep (`requires`) isn't installed.
class ActionMissingDependencyError extends Error {
  constructor(actionName, dep) {
    super(
      'Action "' + actionName + '" requires peer dependency "' + dep +
      '" which is not installed. Install with: npm install ' + dep
    );
    this.name = 'ActionMissingDependencyError';
    this.actionName = actionName;
    this.dep = dep;
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

module.exports = {
  ActionNotRegisteredError: ActionNotRegisteredError,
  ActionMissingDependencyError: ActionMissingDependencyError,
  TransientError: TransientError
};
