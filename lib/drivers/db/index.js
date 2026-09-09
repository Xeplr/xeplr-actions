// DB driver factory. Each action (fetch/push/query) calls getDriver(type)
// to get the right driver, then invokes the common driver interface.
//
// Adding a new DB type = add a file here + register it below.

var DRIVERS = {
  postgres: function() { return require('./postgres'); },
  mysql:    function() { return require('./mysql'); },
  mssql:    function() { return require('./mssql'); },
  mongo:    function() { return require('./mongo'); },
  // Not a server — a file this process opens. See duckdb.js for what that
  // means for who is allowed to open it, which is the whole of the difference.
  duckdb:   function() { return require('./duckdb'); }
};

function getDriver(type) {
  var loader = DRIVERS[type];
  if (!loader) {
    throw new Error('Unknown dbType: "' + type + '". Supported: ' + Object.keys(DRIVERS).join(', '));
  }
  return loader();
}

// Check a driver's peer deps and throw a friendly error if any are missing.
// Called at action execution time (not registration) since the dbType is
// only known when the Job fires.
function checkDriverRequires(actionName, dbType, driver) {
  var requires = (driver && driver.requires) || [];
  for (var i = 0; i < requires.length; i++) {
    try { require.resolve(requires[i]); }
    catch (_) {
      throw new Error(
        actionName + ' requires "' + requires[i] + '" for dbType="' + dbType + '". ' +
        'Install with: npm install ' + requires[i]
      );
    }
  }
}

module.exports = {
  getDriver: getDriver,
  checkDriverRequires: checkDriverRequires,
  SUPPORTED: Object.keys(DRIVERS)
};
