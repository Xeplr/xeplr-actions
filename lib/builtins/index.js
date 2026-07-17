// Built-in actions bundled with @xeplr/actions.
// Each entry is a module — registerAction(mod) picks up the name from mod.name.
// Placeholders throw a "not implemented" error until specced.
//
// Streaming convention (uniform across db/ and file/ actions):
//   - Inputs may include `streaming_mode: boolean` (default false).
//   - When true, reads write to a temp file (JSONL for DB rows, raw for
//     files) and return { filePath, format, bytes, ... } in the output.
//   - When false, data stays inline in output.rows / output.content.
//   - Writes may accept EITHER `rows: []` OR `filePath: '/tmp/...jsonl'`.
//   - Temp dir: XEPLR_ACTIONS_TMP_DIR env var, defaults to
//     os.tmpdir() + '/xeplr-actions/'.
//   - Cleanup: a companion `sweep-temp-files` action (not yet built) will
//     periodically remove files older than a configurable age.

module.exports = {
  // HTTP
  httpRequest:  require('./http-request'),

  // Process
  spawnProgram: require('./spawn-program'),

  // Email
  sendEmail:    require('./send-email'),

  // DB actions (route to db/ drivers per input.dbType)
  dbFetch:      require('./db/fetch'),
  dbPush:       require('./db/push'),
  dbQuery:      require('./db/query'),

  // File actions (route to file/sources + file/formats)
  fileUpload:   require('./file/upload'),
  fileMove:     require('./file/move'),

  // Sub-factories, in case a consumer needs to reach the drivers directly:
  db:   require('./db'),
  file: require('./file')
};
