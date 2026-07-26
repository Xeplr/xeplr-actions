// Default MetaStore — records nothing, returns nothing.
// Used when the uploader is called without a real metaStore instance.
// Consumers wire in meta-store-knex.js (optional peer: knex + pg) or
// their own implementation.

module.exports = {
  async getLast(_opts) { return null; },
  async recordStart(_uploadId, _plan) { /* no-op */ },
  async recordProgress(_uploadId, _delta) { /* no-op */ },
  async recordEnd(_uploadId, _result) { /* no-op */ }
};
