// DuckDB works in UTC, whatever zone the machine is in. Run under a non-UTC
// zone on purpose (TZ below): DuckDB takes the machine's zone by default, and
// on a server in India the month of 1 Aug 00:00 UTC came back as 31 Jul
// 18:30 — a board asked for August said "Jul-2025" — and a filter "to
// 31 Aug" ended at 30 Aug 18:30, dropping the last day.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs'), os = require('os'), path = require('path');
var spawnSync = require('child_process').spawnSync;

// The checks run in a child process with TZ=Asia/Kolkata, so they cannot pass
// merely because this machine happens to be in UTC.
var child = function() {
  var duck = require(process.env.DRIVER);
  (async function() {
    var dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'xeplr-utc-'));
    var out = {};
    for (var access of ['rw', 'ro']) {
      var pool = await duck.connect({ file: require('path').join(dir, 'c.duckdb'), access: access });
      if (access === 'rw') {
        await duck.query(pool, "CREATE TABLE days AS SELECT TIMESTAMPTZ '2025-07-31 00:00:00+00' + INTERVAL (i) DAY AS d FROM range(0, 33) t(i)", []);
      }
      var q = async function(sql, p) { return (await duck.query(pool, sql, p || [])).rows; };
      out[access] = {
        zone: (await q("SELECT current_setting('TimeZone') AS z"))[0].z,
        month: new Date((await q("SELECT date_trunc('month', TIMESTAMPTZ '2025-08-01 00:00:00+00') AS m"))[0].m).toISOString(),
        august: (await q('SELECT count(*) AS n FROM days WHERE d >= $1 AND d < $2', ['2025-08-01', '2025-09-01']))[0].n
      };
      await duck.close(pool);
    }
    console.log(JSON.stringify(out));
  })().catch(function(e) { console.error(e); process.exit(1); });
};

test('date work happens in UTC on a machine in another zone, read-write and read-only alike', function() {
  var script = '(' + child.toString() + ')()';
  var r = spawnSync(process.execPath, ['-e', script], {
    env: Object.assign({}, process.env, { TZ: 'Asia/Kolkata', DRIVER: path.join(__dirname, '../lib/drivers/db/duckdb') }),
    encoding: 'utf8'
  });
  assert.strictEqual(r.status, 0, r.stderr);
  var out = JSON.parse(r.stdout.trim().split('\n').pop());
  for (var access of ['rw', 'ro']) {
    assert.strictEqual(out[access].zone, 'UTC', access + ': the session zone');
    assert.strictEqual(out[access].month, '2025-08-01T00:00:00.000Z', access + ': the month of 1 August is August');
    assert.strictEqual(Number(out[access].august), 31, access + ': August is 31 days, the 1st and the 31st included');
  }
});
