// db-list-foreign-keys action — the foreign keys between the tables of one
// schema/database, each with its columns in key order: { name, table,
// columns, refTable, refColumns }. What an app joins two tables on without
// asking (the BI dataset canvas does). Only keys whose both tables are in the
// schema db-list-tables lists. A small catalogue read, like db-list-tables.

var dbDrivers = require('../../drivers/db');

module.exports = {
  name: 'db-list-foreign-keys',
  description: 'List foreign keys between tables of a schema/database. Routes to the driver named by input.dbType.',
  requires: [],   // per-driver requires checked at runtime once dbType is known

  inputSchema: [
    { name: 'dbType',     type: 'string', required: true, default: 'postgres', order: 1,
      description: 'postgres | mysql | mssql | duckdb' },
    { name: 'connection', type: 'object', required: true, order: 2,
      description: 'Connection config: { host, port, user, password, database } (duckdb: { file })' },
    { name: 'schema',     type: 'string', order: 3,
      description: 'Schema to read (postgres public, duckdb main, mssql every schema, mysql the connection database by default)' }
  ],

  // Only reads the database's own catalogue, so the preview is the run.
  preview: async function(ctx) { return { output: await module.exports.execute(ctx) }; },

  execute: async function(ctx) {
    var input = ctx.input || {};
    var driver = dbDrivers.getDriver(input.dbType);
    dbDrivers.checkDriverRequires('db-list-foreign-keys', input.dbType, driver);
    if (typeof driver.listForeignKeys !== 'function') {
      throw new Error('db-list-foreign-keys: driver "' + input.dbType + '" does not implement listForeignKeys');
    }

    var pool = await driver.connect(input.connection);
    try {
      return { foreignKeys: await driver.listForeignKeys(pool, input.schema) };
    } finally {
      await driver.close(pool);
    }
  }
};
