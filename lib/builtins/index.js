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
  // CALLING a procedure, as opposed to moving what it returns. db-move can
  // still read from one (mode: 'procedure') and both build the statement with
  // drivers/db/procedure.js, so there is one answer to "how is a procedure
  // called" rather than one per caller.
  dbProcedure:  require('./db/procedure'),
  // One window of rows, source DB to target DB, in a single streamed pass —
  // fetchStream piped straight into upload() rather than staged through an
  // NDJSON file the way dbFetch → dbPush does. See db/move.js.
  dbMove:       require('./db/move'),

  // DB introspection — list tables/views/procedures, or one table's columns.
  dbListTables:     require('./db/list-tables'),
  dbListViews:      require('./db/list-views'),
  dbListProcedures: require('./db/list-procedures'),
  dbListColumns:    require('./db/list-columns'),

  // File actions — factory-shaped for the same reason (meta store binding).
  fileUpload:   require('./file/upload'),
  fileMove:     require('./file/move'),

  // Email actions. Inbound routes to getInboundProvider(input.emailType)
  // (imap today), outbound to getOutboundProvider (smtp) — see
  // lib/drivers/email/. Peer deps (imapflow, mailparser, nodemailer) are all
  // optional and lazy-required, so requiring this file never pulls them in.
  //
  // MESSAGE IDS ARE FOLDER-SCOPED. Every message-addressed action takes a
  // `folder`, and a move CHANGES the id — so within one workflow, do the
  // downloads and deletes first and move the message last.
  emailRead:                require('./email/read'),
  emailMove:                require('./email/move'),
  emailDelete:              require('./email/delete'),
  emailDownloadEmail:       require('./email/download-email'),
  emailDownloadAttachments: require('./email/download-attachments')
};
