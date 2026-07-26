// db-list-procedures action — same shape as db-list-tables, lists stored
// procedures instead (excludes functions — see each driver's listProcedures).

var dbDrivers = require('../../drivers/db');

module.exports = {
  name: 'db-list-procedures',
  description: 'List stored procedure names in a schema/database. Routes to the driver named by input.dbType.',
  requires: [],

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
    dbDrivers.checkDriverRequires('db-list-procedures', input.dbType, driver);
    if (typeof driver.listProcedures !== 'function') {
      throw new Error('db-list-procedures: driver "' + input.dbType + '" does not implement listProcedures yet');
    }

    var pool = await driver.connect(input.connection);
    try {
      var procedures = await driver.listProcedures(pool, input.schema);
      return { procedures: procedures };
    } finally {
      await driver.close(pool);
    }
  }
};
