// Runs db-move for real against the dev Postgres — source and target tables
// created here, dropped at the end. Nothing else is touched.
require('dotenv').config({ path: '/Users/vikasbhandari/Dropbox/xeplr-suite/xeplr-bi/backend/development.env' });
var { decrypt } = require('@xeplr/utils/isomorphic/crypto');
var actions = require('@xeplr/actions');
var pg = require('@xeplr/actions/lib/drivers/db/postgres');

var results = [];
function check(name, cond) { results.push([name, cond]); console.log((cond ? '  ok   ' : '  FAIL ') + name); }

var SRC = '__movetest_src', TGT = '__movetest_tgt';

(async function () {
  var login = JSON.parse(await decrypt(process.env.BI_CONNECTION, process.env.ENCRYPTION_KEY));
  var conn = Object.assign({}, login, { database: process.env.DB_API });
  var pool = await pg.connect(conn);

  async function q(sql, p) { return pg.query(pool, sql, p || []); }
  async function rows(sql) { var r = await q(sql); return r.rows || r; }

  await q('DROP TABLE IF EXISTS ' + SRC);
  await q('DROP TABLE IF EXISTS ' + TGT);
  await q('CREATE TABLE ' + SRC + ' (id int, order_date date, amt numeric, note text)');
  await q("INSERT INTO " + SRC + " VALUES " +
    "(1,'2026-01-05',10.5,'jan'),(2,'2026-01-20',20,'jan'),(3,'2026-02-03',30,'feb')," +
    "(4,'2026-02-27',40,'feb'),(5,'2026-03-11',50,'mar')");

  actions.register(actions.builtins.dbMove);
  var base = {
    sourceDbType: 'postgres', sourceConnection: conn, mode: 'table', table: SRC,
    targetDbType: 'postgres', targetConnection: conn, targetTable: TGT,
    columns: [
      { from: 'id', to: 'id' },
      { from: 'order_date', to: 'dt_created' },   // renamed, as discussed
      { from: 'amt', to: 'amount' }
      // `note` deliberately unmapped — must not reach the target
    ]
  };
  var run = function (over) { return actions.runAction('db-move', Object.assign({}, base, over)); };

  console.log('\na window, appended');
  var r1 = await run({ writeMode: 'append', window: { column: 'order_date', from: '2026-01-01', to: '2026-02-01' } });
  check('the move succeeded', r1.status === 'success');
  if (r1.status !== 'success') console.log(JSON.stringify(r1.error, null, 2));
  var t = await rows('SELECT * FROM ' + TGT + ' ORDER BY id');
  // Compared as STRINGS. Postgres hands numeric back as a JS string, and the
  // target column was created numeric by inference — so `=== 1` fails on a
  // row that is perfectly correct. See the type-fidelity note.
  check('only the window came across', t.length === 2 && String(t[0].id) === '1' && String(t[1].id) === '2');
  check('the column was renamed', Object.prototype.hasOwnProperty.call(t[0], 'dt_created'));
  check('the unmapped column was dropped', !Object.prototype.hasOwnProperty.call(t[0], 'note'));
  check('the target table was created by the move', t.length > 0);

  console.log('\nthe next window, appended — half-open, so no overlap');
  await run({ writeMode: 'append', window: { column: 'order_date', from: '2026-02-01', to: '2026-03-01' } });
  t = await rows('SELECT id FROM ' + TGT + ' ORDER BY id');
  check('four rows, no boundary row moved twice', t.length === 4 && t.map(function (x) { return x.id; }).join() === '1,2,3,4');

  console.log('\nupsert');
  await q('CREATE UNIQUE INDEX __movetest_pk ON ' + TGT + ' (id)');
  await q("UPDATE " + SRC + " SET amt = 999 WHERE id = 1");
  var r3 = await run({ writeMode: 'upsert', primaryKeys: ['id'], window: { column: 'order_date', from: '2026-01-01', to: '2026-02-01' } });
  check('the upsert succeeded', r3.status === 'success');
  if (r3.status !== 'success') console.log(JSON.stringify(r3.error, null, 2));
  t = await rows('SELECT id, amount FROM ' + TGT + ' ORDER BY id');
  check('still four rows — updated, not duplicated', t.length === 4);
  check('the changed value landed', Number(t[0].amount) === 999);

  console.log('\nupsert without keys is refused, not downgraded');
  var r4 = await run({ writeMode: 'upsert' });
  check('refused', r4.status === 'failed' && /requires primaryKeys/.test(r4.error.message));

  console.log('\nreplace truncates first');
  var r5 = await run({ writeMode: 'replace' });
  check('the replace succeeded', r5.status === 'success');
  if (r5.status !== 'success') console.log(JSON.stringify(r5.error, null, 2));
  check('it reported truncating', r5.output.truncated === true);
  t = await rows('SELECT id FROM ' + TGT + ' ORDER BY id');
  check('all five rows, exactly once each', t.length === 5 && t.map(function (x) { return x.id; }).join() === '1,2,3,4,5');

  console.log('\na query source is wrapped, so mapping and window still apply');
  var r6 = await run({
    mode: 'query', table: null, sql: 'SELECT id, order_date, amt, note FROM ' + SRC + ' WHERE amt > 15',
    writeMode: 'replace', window: { column: 'order_date', from: '2026-02-01', to: '2026-04-01' }
  });
  check('the query move succeeded', r6.status === 'success');
  if (r6.status !== 'success') console.log(JSON.stringify(r6.error, null, 2));
  t = await rows('SELECT id FROM ' + TGT + ' ORDER BY id');
  check('the query AND the window both applied', t.map(function (x) { return x.id; }).join() === '3,4,5');

  console.log('\na window on a procedure is refused rather than faked');
  var r7 = await run({ mode: 'procedure', table: null, sql: 'some_proc', window: { column: 'order_date', from: '2026-01-01' } });
  check('refused, with the reason', r7.status === 'failed' && /fromParam/.test(r7.error.message));

  await q('DROP TABLE IF EXISTS ' + SRC);
  await q('DROP TABLE IF EXISTS ' + TGT);
  await q('DROP TABLE IF EXISTS ' + TGT + '_import_errors');
  await pg.close(pool);

  var failed = results.filter(function (r) { return !r[1]; });
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch(function (e) { console.error('FAILED:', e.stack || e.message); process.exit(1); });
