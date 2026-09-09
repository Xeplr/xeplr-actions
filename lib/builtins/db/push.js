// db-push action — pushes rows into a target DB table.
//
// Composes: drivers.db.<type> + uploader.upload + SqlQueue
//
// Inputs accept EITHER `rows` (inline) OR `filePath` (NDJSON, one row per line
// — matches spool()'s output shape). The action creates its own SqlQueue per
// call and tears it down when done; movement lifecycle is fully self-contained.

var { upload } = require('../../uploader');
var dbDrivers  = require('../../drivers/db');
var { SqlQueue } = require('@xeplr/utils/lib/queue');
var { generateId } = require('@xeplr/utils/lib/helpers');
var fs = require('fs');
var readline = require('readline');

module.exports = {
  name: 'db-push',
  description: 'Push rows into a target DB table. Supports UPSERT via primaryKeys, ' +
               'NDJSON streaming via filePath, movement-scoped rollback, and error-table ' +
               'routing on failure. Routes to the driver named by input.dbType.',
  requires: [],   // per-driver requires checked at runtime once dbType is known

  inputSchema: [
    // See db/fetch.js for why there are two routes in and why the literal
    // one is not for the job editor. Same contract, same reasons.
    { name: 'connectionInfoId', type: 'string', order: 1,
      optionsFrom: 'connections',
      description: 'A saved connection. Resolved to credentials server-side.' },
    { name: 'dbInfoId',         type: 'string', order: 2,
      optionsFrom: 'databases', dependsOn: 'connectionInfoId',
      description: 'Which database on that connection.' },
    { name: 'dbType',      type: 'string',  required: true, default: 'postgres', order: 3,
      system: true, options: ['postgres', 'mysql', 'mssql', 'mongo'],
      description: 'Taken from the connection when one is chosen.' },
    { name: 'connection',  type: 'object',  required: true, order: 4,
      system: true,
      description: 'Connection config: { host, port, user, password, database }' },
    { name: 'targetTable', type: 'string',  required: true, order: 3 },
    { name: 'primaryKeys', type: 'array',   order: 4,
      description: 'Column names for UPSERT. Empty/omitted = plain INSERT.' },
    { name: 'rows',        type: 'array',   order: 5,
      description: 'Inline rows (mutually exclusive with filePath).' },
    { name: 'filePath',    type: 'string',  order: 6,
      description: 'Path to an NDJSON file (one row per line). Use for large uploads.' },
    { name: 'movementId',  type: 'string',  order: 7, group: 'Advanced',
      description: 'Correlation key for rollback. Defaults to system.occurrenceId or a fresh id.' },
    { name: 'batchSize',   type: 'number',  default: 5000, order: 8, group: 'Performance' },
    { name: 'concurrency', type: 'number',  default: 4,    order: 9, group: 'Performance' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var system = ctx.system || {};

    var driver = dbDrivers.getDriver(input.dbType);
    dbDrivers.checkDriverRequires('db-push', input.dbType, driver);

    var movementId = input.movementId || system.occurrenceId || ('mv_' + generateId());
    var source = resolveSource(input);

    var pool = await driver.connect(input.connection);
    var connectionName = input.targetTable;
    var connections = {};
    connections[connectionName] = pool;

    var queue = new SqlQueue({
      connections: connections,
      // Route through driver.query, not conn.query directly: each driver
      // normalizes the result shape AND binds params dialect-correctly
      // (pg/mysql take a positional array; mssql needs request.input @p0..@pN).
      executor: async function(item, conn) { await driver.query(conn, item.sql, item.params || []); },
      concurrency: input.concurrency || 4,
      maxAttempts: 3
    });

    try {
      return await upload({
        source:              source,
        driver:              driver,
        connection:          pool,
        targetTable:         input.targetTable,
        primaryKeys:         (input.primaryKeys && input.primaryKeys.length) ? input.primaryKeys : null,
        movementId:          movementId,
        queue:               queue,
        connectionName:      connectionName,
        dbType:              input.dbType,       // recorded in import_meta
        // Movement metadata persists to xeplr_config when the framework supplies
        // a meta store (meta-store-knex bound to xeplr_config); else no-op.
        metaStore:           ctx.metaStore,
        batchSize:           input.batchSize
      });
    } finally {
      queue.stop();
      await driver.close(pool);
    }
  }
};

// Return an async iterable for whichever input shape the caller supplied.
function resolveSource(input) {
  if (Array.isArray(input.rows) && input.rows.length > 0) return asyncFromArray(input.rows);
  if (input.filePath)                                     return asyncFromNDJSONFile(input.filePath);
  throw new Error('db-push: either input.rows (non-empty) or input.filePath is required');
}

async function* asyncFromArray(rows) {
  for (var i = 0; i < rows.length; i++) yield rows[i];
}

async function* asyncFromNDJSONFile(filePath) {
  var stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (var line of rl) {
    if (line.trim().length === 0) continue;
    yield JSON.parse(line);
  }
}
