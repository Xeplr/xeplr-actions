// Read-only connections: SQL the caller did not write cannot write, and cannot
// smuggle a second statement in after the first. Postgres against a real local
// server (skipped without one); MySQL against a stand-in mysql2.
var test = require('node:test');
var assert = require('node:assert');
var Module = require('module');
var { buildProcedureCall } = require('../lib/drivers/db/procedure');

var PG = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || process.env.USER, password: process.env.PGPASSWORD, database: 'postgres' };

test('postgres: a read-only pool refuses writes and stacked statements, and still reads', async function(t) {
  var pg = require('../lib/drivers/db/postgres');
  var admin = await pg.connect(PG);
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await pg.close(admin);
    t.skip('no Postgres available (' + err.message + ')');
    return;
  }
  var table = 'xeplr_actions_ro_' + process.pid;
  await admin.query('CREATE TABLE ' + table + ' (id int)');
  var ro = await pg.connect(Object.assign({ readOnly: true }, PG));
  try {
    var read = await pg.query(ro, 'SELECT count(*)::int AS n FROM ' + table, []);
    assert.equal(read.rows[0].n, 0);
    assert.deepEqual(read.columns, ['n']);

    await assert.rejects(pg.query(ro, 'INSERT INTO ' + table + ' VALUES (1)', []), /read-only transaction/);
    await assert.rejects(pg.query(ro, 'SELECT 1; INSERT INTO ' + table + ' VALUES (2)', []), /multiple commands|cannot insert multiple commands/);
    await assert.rejects(pg.query(ro, "SELECT set_config('transaction_read_only', 'off', false)", []), /read-only|read-write/);

    var rows = [];
    for await (var row of pg.fetchStream(ro, { sql: 'SELECT generate_series(1, 3) AS n', batchSize: 2 })) rows.push(row.n);
    assert.deepEqual(rows, [1, 2, 3], 'streaming still reads');
    var stacked = async function() {
      for await (var r of pg.fetchStream(ro, { sql: 'SELECT 1; INSERT INTO ' + table + ' VALUES (3)' })) { void r; }
    };
    await assert.rejects(stacked(), /multiple commands|syntax/);

    var after = await admin.query('SELECT count(*)::int AS n FROM ' + table);
    assert.equal(after.rows[0].n, 0, 'nothing was written');
  } finally {
    await pg.close(ro);
    await admin.query('DROP TABLE IF EXISTS ' + table);
    await pg.close(admin);
  }
});

test('mysql: objects are stringified, and a read-only pool sets every connection read-only', async function() {
  var created = null;
  var sessions = [];
  var fake = {
    createPool: function(options) {
      var handlers = {};
      created = options;
      return { pool: { on: function(event, fn) { handlers[event] = fn; } }, _open: function() { handlers.connection({ query: function(sql) { sessions.push(sql); } }); } };
    }
  };
  var original = Module._load;
  Module._load = function(request) {
    if (request === 'mysql2/promise') return fake;
    return original.apply(this, arguments);
  };
  try {
    var mysql = require('../lib/drivers/db/mysql');
    var plain = await mysql.connect({ user: 'u' });
    assert.equal(created.stringifyObjects, true);
    assert.ok(!created.multipleStatements);
    assert.equal(typeof plain._open, 'function');

    var ro = await mysql.connect({ user: 'u', readOnly: true });
    ro._open();
    assert.deepEqual(sessions, ['SET SESSION TRANSACTION READ ONLY']);
  } finally {
    Module._load = original;
  }
});

test('procedure parameter names are plain names', function() {
  var driver = { quoteIdent: function(s) { return '"' + s + '"'; } };
  assert.throws(function() {
    buildProcedureCall({ driver: driver, dbType: 'postgres', name: 'refresh', params: [{ name: 'x => 1); DROP TABLE t; --', value: 1 }] });
  }, /letters, digits and _/);
  var ok = buildProcedureCall({ driver: driver, dbType: 'postgres', name: 'refresh', params: [{ name: 'region_id', value: 1 }] });
  assert.ok(/region_id => \$1/.test(ok.sql));
});
