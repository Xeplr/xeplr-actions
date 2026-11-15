// @flags: --test-concurrency=1
// db-fetch format 'parquet' → db-push from the folder, against real Postgres:
// the hand-off a workflow makes to Python and back.
//
//   - a table's DECLARED types reach the Parquet files: numeric (which pg
//     hands node as a string) is a number, a date a DATE, timestamptz an
//     instant — not text guessed from values
//   - db-push reads the folder and creates its target with those types
//   - a query with no rows leaves a finished, empty folder that db-push loads
//     as nothing
//
// Its own tables only, made and dropped here.
// Run:  PG_HOST=… PG_USER=… node --test --require ./test/setup-data-dir.cjs test/builtins/parquet-pg.test.js

var db = require('../helpers/databases');
var test = db.testWith('pg');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var pg = require('pg');
var { runAction } = require('../../lib/runner');
var parquet = require('../../lib/formats/parquet');

var CONN = db.config('pg', 'xeplr_actions_test');
var pool = null;
var made = [];
function table(prefix) { var t = prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); made.push(t); return t; }

async function run(action, input) {
  var res = await runAction(action, input, { system: {} });
  if (res.status !== 'success') throw res.error || new Error('failed: ' + JSON.stringify(res));
  return res.output;
}

test.before(async function() {
  var admin = new pg.Pool(Object.assign({}, CONN, { database: 'postgres', connectionTimeoutMillis: 3000 }));
  var res = await admin.query("SELECT 1 FROM pg_database WHERE datname='xeplr_actions_test'");
  if (res.rows.length === 0) await admin.query('CREATE DATABASE xeplr_actions_test');
  await admin.end();
  pool = new pg.Pool(CONN);
});
test.after(async function() {
  if (!pool) return;
  for (var t of made) {
    await pool.query('DROP TABLE IF EXISTS "' + t + '"');
    await pool.query('DROP TABLE IF EXISTS "' + t + '_import_errors"');
  }
  await pool.end();
});

test('a table goes to Parquet with its own types, and comes back into a new table with them', async function() {
  var src = table('pq_src');
  var dst = table('pq_dst');
  await pool.query('CREATE TABLE "' + src + '" (id integer, region text, amount numeric(12,2), day date, ts timestamptz)');
  await pool.query('INSERT INTO "' + src + '" SELECT g, CASE WHEN g % 10 = 0 THEN NULL ELSE \'R\' || (g % 3) END, g * 1.25, DATE \'2026-01-01\' + (g % 28), TIMESTAMPTZ \'2026-01-01 09:00:00+00\' + g * INTERVAL \'1 hour\' FROM generate_series(1, 2500) g');

  var out = await run(require('../../lib/builtins/db/fetch'),
    { dbType: 'postgres', connection: CONN, mode: 'table', table: src, format: 'parquet', partRows: 1000 });
  assert.equal(out.format, 'parquet');
  assert.equal(out.rows, 2500);
  assert.equal(out.parts, 3);
  assert.ok(fs.existsSync(path.join(out.filePath, '_done')));
  assert.deepEqual(await parquet.columnsOf(out.filePath), [
    { name: 'id', type: 'number' }, { name: 'region', type: 'string' }, { name: 'amount', type: 'number' },
    { name: 'day', type: 'date' }, { name: 'ts', type: 'datetime' }
  ]);

  var pushed = await run(require('../../lib/builtins/db/push'),
    { dbType: 'postgres', connection: CONN, targetTable: dst, filePath: out.filePath });
  assert.equal(pushed.completed, 2500);

  var types = (await pool.query('SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1', [dst])).rows;
  var byName = {};
  types.forEach(function(r) { byName[r.column_name] = r.data_type; });
  assert.equal(byName.day, 'date');
  assert.equal(byName.ts, 'timestamp with time zone');
  assert.notEqual(byName.amount, 'text', 'numeric arrives as a number, not as text');

  var diff = await pool.query(
    'SELECT count(*)::int AS n FROM (SELECT id, region, amount::float8 AS amount, day, ts FROM "' + src + '" ' +
    'EXCEPT SELECT id::int, region, amount::float8, day, ts FROM "' + dst + '") d');
  assert.equal(diff.rows[0].n, 0, 'every row arrives unchanged');
});

test('a query with no rows leaves a finished empty folder, which loads as nothing', async function() {
  var src = table('pq_none');
  var dst = table('pq_none_dst');
  await pool.query('CREATE TABLE "' + src + '" (id integer)');
  var out = await run(require('../../lib/builtins/db/fetch'),
    { dbType: 'postgres', connection: CONN, mode: 'query', sql: 'SELECT * FROM "' + src + '"', format: 'parquet' });
  assert.equal(out.rows, 0);
  assert.deepEqual(fs.readdirSync(out.filePath), ['_done']);
  var pushed = await run(require('../../lib/builtins/db/push'),
    { dbType: 'postgres', connection: CONN, targetTable: dst, filePath: out.filePath });
  assert.equal(pushed.completed || 0, 0);
});
