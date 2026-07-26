// db-list-views action — same shape as db-list-tables, lists views instead.

var dbDrivers = require('../../drivers/db');

module.exports = {
  name: 'db-list-views',
  description: 'List view names in a schema/database. Routes to the driver named by input.dbType.',
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
    dbDrivers.checkDriverRequires('db-list-views', input.dbType, driver);
    if (typeof driver.listViews !== 'function') {
      throw new Error('db-list-views: driver "' + input.dbType + '" does not implement listViews yet');
    }

    var pool = await driver.connect(input.connection);
    try {
      var views = await driver.listViews(pool, input.schema);
      return { views: views };
    } finally {
      await driver.close(pool);
    }
  }
};
