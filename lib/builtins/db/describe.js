// db-describe action — a whole database's structure, read from its own
// catalogue and nothing else: every table with its schema, columns, types,
// primary key and comments, and the foreign keys between them (see
// drivers/db/describe.js for the shape). A few catalogue queries however many
// tables there are, never one per table, and never a row of data. What an app
// builds a schema digest from — a summary a language model can turn a
// question into a query plan with.

var dbDrivers = require('../../drivers/db');

module.exports = {
  name: 'db-describe',
  description: 'A whole database\'s tables, columns, types, keys, comments and foreign keys, from its catalogue only. Routes to the driver named by input.dbType.',
  requires: [],   // per-driver requires checked at runtime once dbType is known

  inputSchema: [
    { name: 'dbType',     type: 'string', required: true, default: 'postgres', order: 1,
      description: 'postgres | mysql | mssql | duckdb' },
    { name: 'connection', type: 'object', required: true, order: 2,
      description: 'Connection config: { host, port, user, password, database } (duckdb: { file })' },
    { name: 'schema',     type: 'string', order: 3,
      description: 'One schema only (default: every schema — postgres, mssql and duckdb all but the system ones; mysql the connection database)' }
  ],

  // Only reads the database's own catalogue, so the preview is the run.
  preview: async function(ctx) { return { output: await module.exports.execute(ctx) }; },

  execute: async function(ctx) {
    var input = ctx.input || {};
    var driver = dbDrivers.getDriver(input.dbType);
    dbDrivers.checkDriverRequires('db-describe', input.dbType, driver);
    if (typeof driver.describeDatabase !== 'function') {
      throw new Error('db-describe: driver "' + input.dbType + '" does not implement describeDatabase');
    }

    var pool = await driver.connect(input.connection);
    try {
      return await driver.describeDatabase(pool, input.schema);
    } finally {
      await driver.close(pool);
    }
  }
};
