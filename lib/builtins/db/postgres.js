// Postgres driver — implementation pending user's function-signature spec.
// Peer dep: pg
//
// Expected interface (once specced):
//   requires:            ['pg']
//   async connect(config)                       → { client, close() }
//   async fetchTable(client, opts)              → rows
//   async fetchQuery(client, opts)              → rows
//   async callProcedure(client, opts)           → rows
//   async insert(client, {table, rows})         → { affected }
//   async upsert(client, {table, rows, upsertKey}) → { affected }
//   async truncate(client, {table})             → void
//   async transaction(client, fn)               → whatever fn returns

module.exports = {
  requires: ['pg']
  // functions to be filled in
};
