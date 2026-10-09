// DATES SURVIVE A MOVE THE SAME WAY, WHEREVER THIS PROCESS RUNS.
//
// The three rules (lib/drivers/db/dateValues.js), proven end to end — a real
// table in each source database moved into DuckDB by db-move:
//
//   date                  copied as the same day
//   date-time, no zone    copied as its digits (10:00 stays 10:00), zoneless
//   date-time with a zone copied as the same instant
//
// Each move runs twice, in a child process with TZ set to India and then to
// New York, and the two must store exactly the same thing. A driver that read
// a value in the machine's zone — a plain date a day early west of UTC, a
// TIMESTAMP 5½ hours off — fails here.
//
// The zoned value is WRITTEN from a session in India time (+05:30), so the
// driver's own pin to UTC is what makes it read back right.
//
// Needs live databases; a source that cannot be reached is skipped and says so.
//   MySQL       MYSQL_HOST/PORT/USER/PASSWORD   (database xeplr_actions_test)
//   Postgres    PG_HOST/PORT/USER/PASSWORD      (database postgres)
//   SQL Server  MSSQL_HOST/PORT/USER/PASSWORD   (database master)
var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var spawnSync = require('child_process').spawnSync;

var SOURCES = {
  mysql: {
    connection: { host: process.env.MYSQL_HOST || 'localhost', port: parseInt(process.env.MYSQL_PORT || '3306', 10),
      user: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD || 'break_karo', database: 'xeplr_actions_test' },
    // Written from an India-time session: 15:30 there is 10:00 UTC.
    setup: [
      'DROP TABLE IF EXISTS xz_src',
      'CREATE TABLE xz_src (id INT, d DATE, wall DATETIME, inst TIMESTAMP NULL)',
      "SET time_zone = '+05:30'",
      "INSERT INTO xz_src VALUES (1, '2026-01-05', '2026-01-05 10:00:00', '2026-01-05 15:30:00')"
    ]
  },
  postgres: {
    connection: { host: process.env.PG_HOST || 'localhost', port: parseInt(process.env.PG_PORT || '5432', 10),
      user: process.env.PG_USER || process.env.USER, password: process.env.PG_PASSWORD, database: 'postgres' },
    setup: [
      'DROP TABLE IF EXISTS xz_src',
      'CREATE TABLE xz_src (id int, d date, wall timestamp, inst timestamptz)',
      "SET TIME ZONE 'Asia/Kolkata'",
      "INSERT INTO xz_src VALUES (1, '2026-01-05', '2026-01-05 10:00:00', '2026-01-05 15:30:00')"
    ]
  },
  mssql: {
    connection: { host: process.env.MSSQL_HOST || 'localhost', port: parseInt(process.env.MSSQL_PORT || '1433', 10),
      user: process.env.MSSQL_USER || 'sa', password: process.env.MSSQL_PASSWORD || 'Crazypwd123!', database: 'master' },
    setup: [
      "IF OBJECT_ID('xz_src') IS NOT NULL DROP TABLE xz_src",
      'CREATE TABLE xz_src (id INT, d DATE, wall DATETIME2, inst DATETIMEOFFSET)',
      "INSERT INTO xz_src VALUES (1, '2026-01-05', '2026-01-05 10:00:00', '2026-01-05 15:30:00 +05:30')"
    ]
  }
};

// Runs in the child, under the TZ it was given. Prints one JSON line.
var child = function() {
  // The runner and the action, not the package index (which needs host peers).
  var runAction = require(process.env.ACTIONS + '/lib/runner').runAction;
  var dbMove = require(process.env.ACTIONS + '/lib/builtins/db/move');
  var drivers = require(process.env.ACTIONS + '/lib/drivers/db');
  var duck = require(process.env.ACTIONS + '/lib/drivers/db/duckdb');
  var sources = JSON.parse(process.env.SOURCES);
  var dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'xz-'));
  (async function() {
    var out = {};
    for (var name of Object.keys(sources)) {
      var src = sources[name];
      var driver = drivers.getDriver(name);
      var pool;
      try { pool = await driver.connect(src.connection); } catch (e) { out[name] = { skipped: e.message }; continue; }
      try {
        // One session for the setup, so its zone holds for the insert.
        for (var sql of src.setup) await driver.query(pool, sql, []);
      } catch (e) { out[name] = { skipped: e.message }; await driver.close(pool); continue; }
      await driver.close(pool);

      var file = require('path').join(dir, name + '.duckdb');
      var r = await runAction({ action: dbMove, input: {
        sourceDbType: name, sourceConnection: src.connection, mode: 'table', table: 'xz_src',
        targetDbType: 'duckdb', targetConnection: { file: file, access: 'rw' }, targetTable: 'xz', writeMode: 'append'
      } });
      if (r.status !== 'success') { out[name] = { error: JSON.stringify(r.error) }; continue; }
      var dp = await duck.connect({ file: file, access: 'rw' });
      var row = (await duck.query(dp,
        'SELECT CAST(d AS VARCHAR) AS d, CAST(wall AS VARCHAR) AS wall, typeof(wall) AS wallType, ' +
        'CAST(inst AS VARCHAR) AS inst, typeof(inst) AS instType, typeof(d) AS dType FROM xz', [])).rows[0];
      await duck.close(dp);
      out[name] = row;
    }

    // An older warehouse table: its zoneless column created ZONED, the digits
    // held as if UTC. The next move retypes it, keeping them.
    var older = require('path').join(dir, 'older.duckdb');
    var op = await duck.connect({ file: older, access: 'rw' });
    await duck.query(op, 'CREATE TABLE xz ("__xeplr_movement_id__" VARCHAR NOT NULL, id INTEGER, wall TIMESTAMPTZ)', []);
    await duck.query(op, "INSERT INTO xz VALUES ('old', 0, TIMESTAMPTZ '2026-01-04 23:00:00+00')", []);
    await duck.close(op);
    var first = Object.keys(out).find(function(n) { return out[n] && out[n].wall; });
    if (first) {
      var r2 = await runAction({ action: dbMove, input: {
        sourceDbType: first, sourceConnection: sources[first].connection, mode: 'table', table: 'xz_src',
        columns: [{ from: 'id', to: 'id' }, { from: 'wall', to: 'wall' }],
        targetDbType: 'duckdb', targetConnection: { file: older, access: 'rw' }, targetTable: 'xz', writeMode: 'append'
      } });
      op = await duck.connect({ file: older, access: 'rw' });
      out.retyped = r2.status !== 'success' ? { error: JSON.stringify(r2.error) } :
        (await duck.query(op, 'SELECT any_value(typeof(wall)) AS t, string_agg(CAST(wall AS VARCHAR), \'|\' ORDER BY id) AS v FROM xz', [])).rows[0];
      await duck.close(op);
    }
    console.log(JSON.stringify(out));
    process.exit(0);
  })().catch(function(e) { console.error(e); process.exit(1); });
};

function runIn(tz) {
  var r = spawnSync(process.execPath, ['-e', '(' + child.toString() + ')()'], {
    env: Object.assign({}, process.env, { TZ: tz, ACTIONS: path.join(__dirname, '..'), SOURCES: JSON.stringify(SOURCES) }),
    encoding: 'utf8', timeout: 180000
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('every source, moved into DuckDB from India and from New York, stores the same values by the three rules', function() {
  var india = runIn('Asia/Kolkata');
  var newYork = runIn('America/New_York');
  var tested = 0;
  Object.keys(SOURCES).forEach(function(name) {
    var a = india[name];
    if (a && a.skipped) { console.log('  skipped ' + name + ' — ' + a.skipped); return; }
    assert.ok(a && !a.error, name + ': the move failed — ' + (a && a.error));
    tested++;
    assert.strictEqual(a.dType, 'DATE', name + ': a date stays a date');
    assert.strictEqual(a.d, '2026-01-05', name + ': the same day');
    assert.strictEqual(a.wallType, 'TIMESTAMP', name + ': a zoneless date-time stays zoneless');
    assert.strictEqual(a.wall, '2026-01-05 10:00:00', name + ': its digits as they were');
    assert.strictEqual(a.instType, 'TIMESTAMP WITH TIME ZONE', name + ': a zoned date-time stays an instant');
    assert.strictEqual(a.inst, '2026-01-05 10:00:00+00', name + ': the same instant (written as 15:30 in +05:30)');
    assert.deepStrictEqual(newYork[name], a, name + ': New York stored exactly what India stored');
  });
  assert.ok(tested > 0, 'no source database could be reached');
  if (india.retyped) {
    assert.ok(!india.retyped.error, 'the retyping move failed — ' + india.retyped.error);
    assert.strictEqual(india.retyped.t, 'TIMESTAMP', 'an older zoned column is retyped to zoneless');
    assert.strictEqual(india.retyped.v, '2026-01-04 23:00:00|2026-01-05 10:00:00', '...its old digits kept, the new row as its digits');
    assert.deepStrictEqual(newYork.retyped, india.retyped, 'the retype is the same from New York');
  }
});
