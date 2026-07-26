// db-list-tables action — routes to getDriver(input.dbType) and lists base
// tables (never views) visible to the given schema/database. Small metadata
// read, no streaming — parity with db-fetch/db-push on connection lifecycle
// only (connect, use, close).

var dbDrivers = require('../../drivers/db');

module.exports = {
  name: 'db-list-tables',
  description: 'List base table names in a schema/database. Routes to the driver named by input.dbType.',
  requires: [],   // per-driver requires checked at runtime once dbType is known

  inputSchema: [
    { name: 'dbType',     type: 'string', required: true, default: 'postgres', order: 1,
      description: 'postgres | mysql | mssql' },
    { name: 'connection', type: 'object', required: true, order: 2,
      description: 'Connection config: { host, port, user, password, database }' },
    { name: 'schema',     type: 'string', order: 3,
      description: 'Schema to list (postgres/mssql — default public/all; mysql ignores this in favor of connection.database)' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var driver = dbDrivers.getDriver(input.dbType);
    dbDrivers.checkDriverRequires('db-list-tables', input.dbType, driver);
    if (typeof driver.listTables !== 'function') {
      throw new Error('db-list-tables: driver "' + input.dbType + '" does not implement listTables yet');
    }

    var pool = await driver.connect(input.connection);
    try {
      var tables = await driver.listTables(pool, input.schema);
      return { tables: tables };
    } finally {
      await driver.close(pool);
    }
  }
};
