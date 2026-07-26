// file-upload action — read from a file source (local / sftp / sharepoint /
// google), parse via a format (csv / excel / txt / json), push to a target DB.
//
// The full pipe: [source stream] → [format parser] → [rows async iterable]
//                → [uploader.upload → SqlQueue → DB]
//
// Composed from primitives that are all separately usable — a consumer that
// just wants "give me rows from this CSV without touching a DB" can call
// getFormat('csv').parseStream(fs.createReadStream(path)) directly.

var { upload } = require('../../uploader');
var fileSources = require('../../drivers/file');
var formats     = require('../../formats');
var dbDrivers   = require('../../drivers/db');
var { SqlQueue } = require('@xeplr/utils/lib/queue');
var { generateId } = require('@xeplr/utils/lib/helpers');

module.exports = {
  name: 'file-upload',
  description: 'Read a file (CSV / Excel / JSON / TXT) from a source ' +
               '(local / sftp / sharepoint / google) and push rows into a target DB table. ' +
               'Types + columns are inferred from the first N rows.',
  requires: [],   // per-source/format/driver checks happen at runtime

  inputSchema: [
    // SOURCE
    { name: 'sourceType',    type: 'string',  required: true, default: 'local', order: 1,
      description: 'local | sftp | sharepoint | google' },
    { name: 'sourcePath',    type: 'string',  required: true, order: 2,
      description: 'File path (local) or key/id (remote sources)' },
    { name: 'sourceConfig',  type: 'object',  default: {}, order: 3,
      description: 'Source-specific config (SFTP creds, SharePoint site, etc.)' },

    // FORMAT
    { name: 'format',        type: 'string',  required: true, default: 'csv', order: 4,
      description: 'csv | excel | txt | json' },
    { name: 'formatConfig',  type: 'object',  default: {}, order: 5,
      description: 'Format-specific options (delimiter, sheet name, etc.)' },

    // TARGET
    { name: 'dbType',        type: 'string',  required: true, default: 'postgres', order: 10 },
    { name: 'dbConnection',  type: 'object',  required: true, order: 11 },
    { name: 'targetTable',   type: 'string',  required: true, order: 12 },
    { name: 'primaryKeys',   type: 'array',   order: 13 },

    // CONTROL
    { name: 'movementId',    type: 'string',  order: 20 },
    { name: 'batchSize',     type: 'number',  default: 5000, order: 21 },
    { name: 'concurrency',   type: 'number',  default: 4,    order: 22 }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var system = ctx.system || {};

    // Resolve source + format + target driver up front so any missing peer
    // dep throws with a clear message before we start touching resources.
    var source = fileSources.getSource(input.sourceType);
    fileSources.checkSourceRequires('file-upload', input.sourceType, source);

    var format = formats.getFormat(input.format);
    formats.checkFormatRequires('file-upload', input.format, format);

    var driver = dbDrivers.getDriver(input.dbType);
    dbDrivers.checkDriverRequires('file-upload', input.dbType, driver);

    // Some formats need a stream (csv, json, txt — pure pipe semantics);
    // some need a file path (xlsx — the zip central directory is at the file
    // tail so unzipper must seek). The format declares which via `inputMode`;
    // sources implement whichever their transport can serve.
    var sourceCfg = Object.assign({}, input.sourceConfig, { path: input.sourcePath });
    var rowsIterable;
    if (format.inputMode === 'path') {
      if (typeof source.openPath !== 'function') {
        throw new Error("file-upload: format '" + input.format + "' requires a file path but source '" +
                        input.sourceType + "' does not implement openPath(). Add openPath() to the source " +
                        "(local sources should return config.path; remote sources should download to a tmp path).");
      }
      var filePath = await source.openPath(sourceCfg);
      rowsIterable = format.parsePath(filePath, input.formatConfig || {});
    } else {
      var stream = await source.openStream(sourceCfg);
      rowsIterable = format.parseStream(stream, input.formatConfig || {});
    }

    // Set up target
    var movementId = input.movementId || system.occurrenceId || ('mv_' + generateId());
    var pool = await driver.connect(input.dbConnection);
    var connections = {};
    connections[input.targetTable] = pool;

    var queue = new SqlQueue({
      connections: connections,
      executor: async function(item, conn) { await conn.query(item.sql, item.params || []); },
      concurrency: input.concurrency || 4,
      maxAttempts: 3
    });

    try {
      return await upload({
        source:         rowsIterable,
        driver:         driver,
        connection:     pool,
        targetTable:    input.targetTable,
        primaryKeys:    (input.primaryKeys && input.primaryKeys.length) ? input.primaryKeys : null,
        movementId:     movementId,
        queue:          queue,
        connectionName: input.targetTable,
        dbType:         input.dbType,   // recorded in import_meta
        batchSize:      input.batchSize,
        // Movement metadata persists to xeplr_configs when the caller supplies
        // a meta store (meta-store-knex); else no-op. mtId1-4/details are
        // opaque tenant/app context — see runner.js's ctx.system passthrough.
        metaStore:      ctx.metaStore,
        mtId1: system.mtId1, mtId2: system.mtId2, mtId3: system.mtId3, mtId4: system.mtId4,
        details:        system.details
      });
    } finally {
      queue.stop();
      await driver.close(pool);
    }
  }
};
