// MongoDB driver — implementation pending user spec.
// Peer dep: mongodb
// Implements the same interface as db/postgres.js (adapted for BSON queries
// — likely fetchQuery takes a filter object, not SQL).

module.exports = {
  requires: ['mongodb']
};
