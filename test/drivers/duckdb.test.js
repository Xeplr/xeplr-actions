// DuckDB driver. Unlike the other driver tests this needs NO live server —
// the database is a file, so this runs anywhere.
//
//   node --test test/drivers/duckdb.test.js
//
// Peer dep: @duckdb/node-api must be resolvable from here.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');
var { spawn } = require('node:child_process');

var driver = require('../../lib/drivers/db/duckdb');

var DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-duck-'));
var FILE = path.join(DIR, 'wh.duckdb');
var pool = null;

function tempTable() {
  return 'test_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

var COLUMNS = [
  { name: 'order_id',   type: 'string' },
  { name: 'region',     type: 'string' },
  { name: 'revenue',    type: 'number' },
  { name: 'is_paid',    type: 'boolean' },
  { name: 'ordered_at', type: 'datetime' },
  { name: 'order_day',  type: 'date' },
  { name: 'meta',       type: 'object' }
];

test.before(async function() {
  // access:'rw' said out loud — the driver opens read-only otherwise.
  pool = await driver.connect({ file: FILE, access: 'rw' });
});

test.after(async function() {
  if (pool) await driver.close(pool);
  fs.rmSync(DIR, { recursive: true, force: true });
});

test('creates a table and round-trips every logical type', async function() {
  var t = tempTable();
  await driver.query(pool, driver.buildCreateTableSql(t, COLUMNS));
  await driver.query(pool, driver.buildCreateErrorTableSql(t));

  var ins = driver.buildInsertSql(t, [
    { order_id: 'A1', region: 'IN', revenue: 100.5, is_paid: true,
      ordered_at: new Date('2026-01-05T10:00:00Z'), order_day: new Date(2026, 0, 5),
      meta: { source: 'web' } },
    { order_id: 'A2', region: 'US', revenue: '250', is_paid: 'no',
      ordered_at: '2026-01-06T11:30:00Z', order_day: '2026-01-06', meta: null }
  ], COLUMNS, 'mv-1');

  await driver.query(pool, ins.sql, ins.params);

  var r = await driver.query(pool,
    'SELECT * FROM ' + driver.quoteIdent(t) + ' ORDER BY order_id');

  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.columns.includes('__xeplr_movement_id__'), true);

  var a1 = r.rows[0];
  assert.equal(a1.order_id, 'A1');
  assert.equal(a1.revenue, 100.5);
  assert.equal(a1.is_paid, true);
  assert.equal(a1.__xeplr_movement_id__, 'mv-1');

  // A date must NOT drift a day. This is the whole reason toDateOnly exists:
  // a Date holding local 2026-01-05 becomes 2026-01-04 via toISOString()
  // anywhere east of Greenwich, and this test only catches that when it runs
  // in a non-UTC zone — so it is asserted on the UTC calendar date rather than
  // on String(date), which renders in the runner's zone and passes either way.
  assert.equal(new Date(a1.order_day).toISOString().slice(0, 10), '2026-01-05');
  assert.equal(new Date(r.rows[1].order_day).toISOString().slice(0, 10), '2026-01-06');

  // '250' → number, 'no' → false: the coercions the uploader relies on.
  assert.equal(r.rows[1].revenue, 250);
  assert.equal(r.rows[1].is_paid, false);
});

test('upserts on the primary key rather than duplicating', async function() {
  var t = tempTable();
  var cols = [{ name: 'k', type: 'string' }, { name: 'v', type: 'number' }];

  await driver.query(pool, driver.buildCreateTableSql(t, cols, ['k']));
  await driver.ensureUpsertIndex(pool, t, ['k']);

  var first = driver.buildInsertSql(t, [{ k: 'a', v: 1 }], cols, 'mv-1', ['k']);
  await driver.query(pool, first.sql, first.params);

  var second = driver.buildInsertSql(t, [{ k: 'a', v: 2 }], cols, 'mv-2', ['k']);
  await driver.query(pool, second.sql, second.params);

  var r = await driver.query(pool, 'SELECT k, v, __xeplr_movement_id__ AS m FROM ' + driver.quoteIdent(t));
  assert.equal(r.rows.length, 1, 'upsert must update, not insert a second row');
  assert.equal(r.rows[0].v, 2);
  // The movement id always moves with the update — otherwise rollback would
  // miss a row the latest movement actually changed.
  assert.equal(r.rows[0].m, 'mv-2');
});

test('adds a column to an existing table, idempotently', async function() {
  var t = tempTable();
  await driver.query(pool, driver.buildCreateTableSql(t, [{ name: 'a', type: 'string' }]));

  var sqls = driver.buildAlterTableAddSql(t, [{ name: 'b', type: 'number' }]);
  for (var i = 0; i < sqls.length; i++) await driver.query(pool, sqls[i]);
  for (var j = 0; j < sqls.length; j++) await driver.query(pool, sqls[j]);   // twice

  var schema = await driver.getTableSchema(pool, t);
  var names = schema.map(function(c) { return c.name; });
  assert.deepEqual(names.includes('b'), true);
});

test('reads the target schema, and maps DuckDB types back to logical ones', async function() {
  var t = tempTable();
  await driver.query(pool, driver.buildCreateTableSql(t, COLUMNS));

  var schema = await driver.getTableSchema(pool, t);
  var byName = {};
  schema.forEach(function(c) { byName[c.name] = driver.dataTypeToLogical(c.dataType); });

  assert.equal(byName.order_id, 'string');
  assert.equal(byName.revenue, 'number');
  assert.equal(byName.is_paid, 'boolean');
  assert.equal(byName.ordered_at, 'datetime');
  assert.equal(byName.order_day, 'date');
  assert.equal(byName.meta, 'object');
});

test('dataTypeToLogical handles parameterised types', function() {
  // DuckDB reports these with their parameters attached, which a whole-string
  // lookup misses — and missing means "string", i.e. a number column silently
  // reconciled as text.
  assert.equal(driver.dataTypeToLogical('DECIMAL(18,3)'), 'number');
  assert.equal(driver.dataTypeToLogical('VARCHAR'), 'string');
  assert.equal(driver.dataTypeToLogical('TIMESTAMP WITH TIME ZONE'), 'datetime');
  assert.equal(driver.dataTypeToLogical('STRUCT(a INTEGER)'), 'object');
  assert.equal(driver.dataTypeToLogical(null), 'string');
});

test('lists tables and views; procedures are empty rather than an error', async function() {
  var t = tempTable();
  await driver.query(pool, driver.buildCreateTableSql(t, [{ name: 'a', type: 'string' }]));
  await driver.query(pool, 'CREATE VIEW ' + driver.quoteIdent(t + '_v') +
    ' AS SELECT * FROM ' + driver.quoteIdent(t));

  var tables = await driver.listTables(pool);
  var views = await driver.listViews(pool);

  assert.deepEqual(tables.includes(t), true);
  assert.deepEqual(views.includes(t + '_v'), true);
  assert.deepEqual(await driver.listProcedures(pool), []);
});

test('streams a large result without materialising it', async function() {
  var seen = 0;
  var last = null;
  // More than one chunk (DuckDB chunks at ~2048 rows) so fetchChunk actually
  // loops rather than returning everything on the first pull.
  for await (var row of driver.fetchStream(pool, {
    sql: 'SELECT range AS id, range * 2 AS dbl FROM range(10000)'
  })) {
    seen++;
    last = row;
  }
  assert.equal(seen, 10000);
  assert.equal(last.id, 9999);
  assert.equal(last.dbl, 19998);
  // BIGINT arrives as BigInt from DuckDB and would poison arithmetic and
  // JSON.stringify downstream if it were passed through.
  assert.equal(typeof last.id, 'number');
});

test('rolls a movement back, including when no error table was ever created', async function() {
  var t = tempTable();
  var cols = [{ name: 'a', type: 'string' }];
  await driver.query(pool, driver.buildCreateTableSql(t, cols));

  var m1 = driver.buildInsertSql(t, [{ a: 'x' }, { a: 'y' }], cols, 'mv-1');
  await driver.query(pool, m1.sql, m1.params);
  var m2 = driver.buildInsertSql(t, [{ a: 'z' }], cols, 'mv-2');
  await driver.query(pool, m2.sql, m2.params);

  var result = await driver.rollbackMovement(pool, t, 'mv-1');
  assert.equal(result.mainDeleted, 2);
  assert.equal(result.errorDeleted, 0);   // table absent — normal, not a failure

  var left = await driver.query(pool, 'SELECT a FROM ' + driver.quoteIdent(t));
  assert.equal(left.rows.length, 1);
  assert.equal(left.rows[0].a, 'z');
});

// ── the access rule ──────────────────────────────────────────────────────

test('rowCount on DML is rows CHANGED, not the size of the result', async function() {
  // DuckDB answers an INSERT/DELETE with a one-row result holding the count,
  // so reading rows.length reports 1 no matter how many rows moved. It is
  // silent, and rollbackMovement believes it.
  var t = tempTable();
  var cols = [{ name: 'a', type: 'string' }];
  await driver.query(pool, driver.buildCreateTableSql(t, cols));

  var ins = driver.buildInsertSql(t,
    [{ a: 'p' }, { a: 'q' }, { a: 'r' }], cols, 'mv-1');
  var inserted = await driver.query(pool, ins.sql, ins.params);
  assert.equal(inserted.rowCount, 3);

  var deleted = await driver.query(pool, 'DELETE FROM ' + driver.quoteIdent(t) + " WHERE a <> 'p'");
  assert.equal(deleted.rowCount, 2);

  // A SELECT still counts its rows, which is the case the DML branch must not
  // break on its way past.
  var sel = await driver.query(pool, 'SELECT a FROM ' + driver.quoteIdent(t));
  assert.equal(sel.rowCount, 1);
  assert.deepEqual(sel.columns, ['a']);
});

test('read-only is the default, and writing has to be asked for', function() {
  // The whole access rule. Nothing is read from the environment: a
  // process-wide setting means the same code behaves differently depending on
  // where it runs, and nothing at the point of a write says whether it is
  // allowed.
  assert.equal(driver.accessMode(), 'ro', 'no config at all means read-only');
  assert.equal(driver.accessMode({}), 'ro', 'a config that says nothing means read-only');
  assert.equal(driver.accessMode({ access: 'rw' }), 'rw');
  assert.equal(driver.accessMode({ access: 'ro' }), 'ro');

  // An env var must NOT be able to turn a read into a write behind the code's
  // back — that is precisely the design that was removed.
  var saved = process.env.XEPLR_DW_ACCESS;
  process.env.XEPLR_DW_ACCESS = 'rw';
  try {
    assert.equal(driver.accessMode(), 'ro', 'the environment cannot grant write access');
  } finally {
    if (saved === undefined) delete process.env.XEPLR_DW_ACCESS;
    else process.env.XEPLR_DW_ACCESS = saved;
  }

  assert.throws(function() { driver.accessMode({ access: 'maybe' }); }, /must be "rw".*or.*"ro"/s);
});

test('a second writer WAITS for the first, rather than failing at it', async function() {
  // This is what lets read-only be the default and no process be special: the
  // file's own lock is the mutex, so two writers need no knowledge of each
  // other. Without the wait, the second one errors and the work is lost.
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-duck-wait-'));
  var file = path.join(dir, 'wait.duckdb');

  var seed = await driver.connect({ file: file, access: 'rw' });
  await driver.query(seed, 'CREATE TABLE t AS SELECT 1 AS id');
  await driver.close(seed);

  // A child holds the file read-write for ~1.2s, then lets go.
  var holder = `
    var d = require(${JSON.stringify(path.resolve(__dirname, '../../lib/drivers/db/duckdb.js'))});
    d.connect({ file: ${JSON.stringify(file)}, access: 'rw' }).then(async function(p) {
      console.log('HELD');
      await new Promise(function(r) { setTimeout(r, 1200); });
      await d.close(p);
      process.exit(0);
    }).catch(function(e) { console.log('ERR ' + e.message); process.exit(3); });
  `;
  var child = spawn(process.execPath, ['-e', holder], { cwd: path.resolve(__dirname, '../..') });

  // Both promises are created NOW, before either event can fire. Attaching an
  // 'exit' listener further down would never fire — by then the child has
  // already gone, and the await hangs for as long as the runner allows.
  var buf = '';
  child.stdout.on('data', function(d) { buf += d; });
  child.stderr.on('data', function(d) { buf += d; });
  var exited = new Promise(function(res) { child.on('exit', res); });
  var held = new Promise(function(resolve, reject) {
    var give = setTimeout(function() {
      reject(new Error('the holder never signalled. Output: ' + (buf || '(nothing)')));
    }, 10000);
    var poll = setInterval(function() {
      if (buf.indexOf('HELD') > -1) { clearInterval(poll); clearTimeout(give); resolve(); }
    }, 20);
    exited.then(function(code) {
      if (buf.indexOf('HELD') === -1) {
        clearInterval(poll); clearTimeout(give);
        reject(new Error('holder exited ' + code + ' without holding: ' + buf));
      }
    });
  });

  await held;

  // Now try to open it here. It must block and then succeed, not throw.
  var started = Date.now();
  var mine = await driver.connect({ file: file, access: 'rw', openTimeoutMs: 15000 });
  var waited = Date.now() - started;

  var r = await driver.query(mine, 'SELECT id FROM t');
  assert.equal(r.rows[0].id, 1);
  assert.ok(waited > 300, 'it should actually have waited, not raced through: ' + waited + 'ms');

  await driver.close(mine);
  await exited;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('waiting is bounded, and says which of the two things went wrong', async function() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-duck-to-'));
  var file = path.join(dir, 'timeout.duckdb');

  var seed = await driver.connect({ file: file, access: 'rw' });
  await driver.query(seed, 'CREATE TABLE t AS SELECT 1 AS id');
  await driver.close(seed);

  var holder = `
    var d = require(${JSON.stringify(path.resolve(__dirname, '../../lib/drivers/db/duckdb.js'))});
    d.connect({ file: ${JSON.stringify(file)}, access: 'rw' }).then(function() {
      console.log('HELD'); setTimeout(function() { process.exit(0); }, 8000);
    });
  `;
  var child = spawn(process.execPath, ['-e', holder], { cwd: path.resolve(__dirname, '../..') });
  await new Promise(function(resolve) {
    child.stdout.on('data', function(d) { if (String(d).indexOf('HELD') > -1) resolve(); });
  });

  // Waiting forever would turn a stuck writer into a hung request with nothing
  // in the log, so the bound exists and the message has to be useful.
  await assert.rejects(
    driver.connect({ file: file, access: 'ro', openTimeoutMs: 400 }),
    function(err) {
      assert.equal(err.code, 'DUCKDB_LOCKED');
      assert.match(err.message, /gave up waiting/);
      assert.match(err.message, /openTimeoutMs|did not close it/);
      return true;
    }
  );

  child.kill();
  await new Promise(function(res) { child.on('exit', res); });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the same file opened twice in one process shares one instance', async function() {
  // Two DuckDBInstance objects for one path is the same conflicting-lock
  // failure as two processes, self-inflicted. So the second connect must
  // return the first one's handle, and closing it must not shut the file
  // while the first caller is still using it.
  var second = await driver.connect({ file: FILE });
  assert.equal(second.file, pool.file);

  await driver.close(second);

  var r = await driver.query(pool, 'SELECT 1 AS ok');
  assert.equal(r.rows[0].ok, 1, 'closing the second handle must not close the file');
});

test('a read-only process cannot be handed write access', async function() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-duck-ro-'));
  var file = path.join(dir, 'ro.duckdb');

  // Seed it, then let go entirely.
  var rw = await driver.connect({ file: file, access: 'rw' });
  await driver.query(rw, 'CREATE TABLE t AS SELECT 1 AS id');
  await driver.close(rw);

  var ro = await driver.connect({ file: file, access: 'ro' });
  var r = await driver.query(ro, 'SELECT id FROM t');
  assert.equal(r.rows[0].id, 1, 'reading is what read-only is for');

  await assert.rejects(
    driver.query(ro, 'CREATE TABLE t2 (a INTEGER)'),
    /read-only|Cannot execute statement|not allowed/i
  );

  // Asking to write a file this process already holds read-only is a
  // configuration mistake, and it must fail HERE rather than at some later
  // write inside whatever code happened to be running.
  await assert.rejects(
    driver.connect({ file: file, access: 'rw' }),
    /already open READ-ONLY/
  );

  await driver.close(ro);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the cross-process lock is real — a reader cannot slip in mid-write', async function() {
  // The physical fact the whole design is built on, pinned here so a DuckDB
  // upgrade that changed it would be caught rather than assumed.
  //
  // A SHORT openTimeoutMs, because the point is what happens while the file is
  // held. With the default the child would simply wait sixty seconds and then
  // succeed, which is correct behaviour and a useless test.
  var child = `
    var d = require(${JSON.stringify(path.resolve(__dirname, '../../lib/drivers/db/duckdb.js'))});
    d.connect({ file: ${JSON.stringify(FILE)}, openTimeoutMs: 300 })
      .then(function() { console.log('OPENED'); process.exit(0); })
      .catch(function(e) { console.log('ERR:' + e.message.replace(/\\n/g, ' | ')); process.exit(3); });
  `;

  var out = await new Promise(function(resolve) {
    var p = spawn(process.execPath, ['-e', child], { cwd: path.resolve(__dirname, '../..') });
    var buf = '';
    p.stdout.on('data', function(d) { buf += d; });
    p.stderr.on('data', function(d) { buf += d; });
    p.on('exit', function(code) { resolve({ code: code, out: buf.trim() }); });
  });

  // `pool` (opened rw in test.before) is still held by THIS process.
  assert.equal(out.code, 3, 'a reader must not get in while a writer holds it: ' + out.out);
  assert.match(out.out, /gave up waiting/);
  // Read-only was the child's default — it never asked to write, and was still
  // locked out. That asymmetry is the reason cubes are separate files.
  assert.match(out.out, /READ-ONLY/);
});
