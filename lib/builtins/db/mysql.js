// MySQL driver — implementation pending user spec.
// Peer dep: mysql2
// Implements the same interface as db/postgres.js (see that file for the
// full contract, including streaming_mode semantics).

module.exports = {
  requires: ['mysql2']
};
