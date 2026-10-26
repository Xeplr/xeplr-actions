// The test databases, from the environment — never from code.
//
//   PG_HOST    PG_PORT    PG_USER    PG_PASSWORD       Postgres
//   MYSQL_HOST MYSQL_PORT MYSQL_USER MYSQL_PASSWORD    MySQL
//   MSSQL_HOST MSSQL_PORT MSSQL_USER MSSQL_PASSWORD    SQL Server
//
// No HOST set: the file's tests are SKIPPED, saying which settings run them.
// HOST set: they run, and a database that refuses the login FAILS them, so a
// configured run never passes by not connecting.
//
// Why: these files once carried a fixed host, port and password each. On any
// other machine every test failed, so the nested folders were left out of
// the pre-commit gate, and nothing checked them at all (data-operation
// shipped returning no rows). The passwords were also published in this
// public repo.
var nodeTest = require('node:test');

var KINDS = {
  pg: { label: 'Postgres', prefix: 'PG', port: 5432 },
  mysql: { label: 'MySQL', prefix: 'MYSQL', port: 3306 },
  mssql: { label: 'SQL Server', prefix: 'MSSQL', port: 1433 }
};

/** One database's connection, as the drivers take it. */
function config(kind, database) {
  var k = KINDS[kind];
  var e = process.env;
  var out = {
    host: e[k.prefix + '_HOST'],
    port: Number(e[k.prefix + '_PORT'] || k.port),
    user: e[k.prefix + '_USER'],
    password: e[k.prefix + '_PASSWORD']
  };
  if (database) out.database = database;
  return out;
}

/** Why these tests cannot run here, or null when every database is set. */
function missing(kinds) {
  var unset = kinds.filter(function(kind) { return !process.env[KINDS[kind].prefix + '_HOST']; });
  if (!unset.length) return null;
  return 'needs ' + unset.map(function(kind) {
    var p = KINDS[kind].prefix;
    return KINDS[kind].label + ' (' + p + '_HOST, ' + p + '_PORT, ' + p + '_USER, ' + p + '_PASSWORD)';
  }).join(' and ');
}

/**
 * `test` for a file that needs these databases: node:test itself when they
 * are set; otherwise every test is reported skipped with the reason, and its
 * before/after hooks never run (they would only fail to connect).
 */
function testWith() {
  var why = missing(Array.prototype.slice.call(arguments));
  if (!why) return nodeTest;
  function skipped(name, opts, fn) {
    if (typeof opts === 'function') { fn = opts; opts = {}; }
    return nodeTest(name, Object.assign({}, opts, { skip: why }), fn);
  }
  skipped.before = skipped.after = skipped.beforeEach = skipped.afterEach = function() {};
  return skipped;
}

module.exports = { config: config, missing: missing, testWith: testWith };
