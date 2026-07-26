// Built-in actions bundled with @xeplr/actions.
// Each entry is a module — registerAction(mod) picks up the name from mod.name.
// Placeholders throw at register/run time until specced.
//
// Streaming convention (uniform across db/ and file/ actions):
//   - Inputs may include `streaming_mode: boolean` (default false).
//   - When true, reads write to a temp file (rotating NDJSON for db rows,
//     raw for files) and return { filePath | dirPath, format, bytes, ... }
//     in the output.
//   - When false, data stays inline in output.rows / output.content.
//   - Writes may accept EITHER `rows: []` OR a spooled `filePath`/`dirPath`.
//   - Temp dir: XEPLR_ACTIONS_TMP_DIR env var, default os.tmpdir() + '/xeplr-actions/'.
//
// Uploader primitive (lib/uploader/) handles DDL, type inference, TZ, batch
// bisection, and error-table routing. The DB actions here compose it with
// the appropriate driver.

module.exports = {
  // Generic actions (no runtime-config dependency)
  httpRequest:  require('./http-request'),
  spawnProgram: require('./spawn-program'),
  sendEmail:    require('./send-email'),

  // DB actions — factory-shaped (call fileUpload({ metaKnex }) to get a
  // registerable module) so the Knex handle for the meta store binds at
  // configuration time, not runtime.
  dbFetch:      require('./db/fetch'),
  dbPush:       require('./db/push'),
  dbQuery:      require('./db/query'),

  // DB introspection — list tables/views/procedures, or one table's columns.
  dbListTables:     require('./db/list-tables'),
  dbListViews:      require('./db/list-views'),
  dbListProcedures: require('./db/list-procedures'),
  dbListColumns:    require('./db/list-columns'),

  // File actions — factory-shaped for the same reason (meta store binding).
  fileUpload:   require('./file/upload'),
  fileMove:     require('./file/move')
};
