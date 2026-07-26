// db-list-columns action — wraps each driver's existing getTableSchema
// (already used internally by uploader.reconcile) as a standalone action:
// column name + data type for one named table.

var dbDrivers = require('../../drivers/db');

module.exports = {
  name: 'db-list-columns',
  description: 'List a table\'s columns (name + data type). Routes to the driver named by input.dbType.',
  requires: [],

  inputSchema: [
    { name: 'dbType',     type: 'string', required: true, default: 'postgres', order: 1,
      description: 'postgres | mysql | mssql' },
    { name: 'connection', type: 'object', required: true, order: 2,
      description: 'Connection config: { host, port, user, password, database }' },
    { name: 'table',      type: 'string', required: true, order: 3,
      description: 'Table name to introspect' },
    { name: 'schema',     type: 'string', order: 4,
      description: 'Schema the table lives in (postgres/mssql — default public/all; mysql ignores this in favor of connection.database)' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var driver = dbDrivers.getDriver(input.dbType);
    dbDrivers.checkDriverRequires('db-list-columns', input.dbType, driver);
    if (typeof driver.getTableSchema !== 'function') {
      throw new Error('db-list-columns: driver "' + input.dbType + '" does not implement getTableSchema yet');
    }

    var pool = await driver.connect(input.connection);
    try {
      var columns = await driver.getTableSchema(pool, input.table, input.schema);
      return { columns: columns };
    } finally {
      await driver.close(pool);
    }
  }
};
