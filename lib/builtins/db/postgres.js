// Postgres driver — implementation pending user's function-signature spec.
// Peer dep: pg
//
// Interface every db driver implements (uniform across postgres/mysql/mssql/mongo):
//
//   requires:            ['pg']                                         // peer deps
//
//   async connect(connectionConfig)              → { client, close() }
//   async transaction(client, fn)                → whatever fn returns
//
//   // Reads — all accept streaming_mode
//   async fetchTable(client, {
//     table, columns?, where?, limit?, orderBy?, streaming_mode?
//   })  → streaming_mode=false: { rows: [...], count }
//        streaming_mode=true:  { filePath, format:'jsonl', bytes, rows }
//
//   async fetchQuery(client, { query, params?, streaming_mode? }) → same shape
//   async callProcedure(client, { name, params?, streaming_mode? }) → same shape
//
//   // Writes — accept EITHER inline rows OR a filePath (JSONL) to stream from
//   async insert(client, {
//     table, rows?, filePath?, streaming_mode?
//   })  → { affected }
//   async upsert(client, {
//     table, rows?, filePath?, upsertKey, streaming_mode?
//   })  → { affected }
//   async truncate(client, { table })            → void

module.exports = {
  requires: ['pg']
  // functions to be filled in per interface above
};
