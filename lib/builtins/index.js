// Built-in actions bundled with @xeplr/actions.
// Each entry is a module — registerAction(mod) picks up the name from mod.name.
// Placeholders throw a "not implemented" error until specced.

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
