// What an import may do to its target — New table, Append, Replace — and the
// file-against-table comparison an import shows before it loads anything.
// Real DuckDB (in memory) always; real Postgres when PG_HOST/PG_PORT/PG_USER/
// PG_PASSWORD are set (database PG_DATABASE, default 'postgres'); real MySQL
// when MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASSWORD are set (database
// xeplr_actions_test, made if missing).
// Run:  node --test test/import-modes.test.js

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var duckdb = require('../lib/drivers/db/duckdb');
var postgres = require('../lib/drivers/db/postgres');
var mysql = require('../lib/drivers/db/mysql');
var { upload, compareToTable, MODES } = require('../lib/uploader');
var formats = require('../lib/formats');
var { SqlQueue } = require('@xeplr/utils/lib/queue');

function tempTable() { return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
async function* rowsOf(list) { for (var r of list) yield r; }

function queueFor(driver, pool, table) {
  var connections = {}; connections[table] = pool;
  return new SqlQueue({ connections: connections, concurrency: 1, maxAttempts: 1,
    executor: async function(item, conn) { await driver.query(conn, item.sql, item.params || []); } });
}

// One import into `table`; the queue made and stopped around it.
async function load(driver, pool, table, rows, opts) {
  var q = queueFor(driver, pool, table);
  try {
    return await upload(Object.assign({ source: rowsOf(rows), driver: driver, connection: pool,
      targetTable: table, movementId: 'mv-' + Math.random().toString(36).slice(2, 8), queue: q, batchSize: 10 }, opts || {}));
  } finally {
    q.stop();
  }
}

async function count(driver, pool, table) {
  return Number((await driver.query(pool, 'SELECT count(*) AS n FROM ' + driver.quoteIdent(table))).rows[0].n);
}

async function skus(driver, pool, table) {
  return (await driver.query(pool, 'SELECT sku FROM ' + driver.quoteIdent(table) + ' ORDER BY sku')).rows.map(function(r) { return r.sku; });
}

function rows(prefix, n) {
  var out = [];
  for (var i = 1; i <= n; i++) out.push({ sku: prefix + i, qty: i });
  return out;
}

test('the modes are new, append and replace; anything else is refused before a row is read', async function() {
  assert.deepEqual(MODES, ['new', 'append', 'replace']);
  var pool = await duckdb.connect({ file: ':memory:', access: 'rw' });
  try {
    await assert.rejects(load(duckdb, pool, tempTable(), rows('A', 2), { mode: 'merge' }), /mode must be one of new, append, replace/);
  } finally { await duckdb.close(pool); }
});

test('New table: makes it; a second New into the same name is refused and writes nothing', async function() {
  var pool = await duckdb.connect({ file: ':memory:', access: 'rw' });
  var t = tempTable();
  try {
    var first = await load(duckdb, pool, t, rows('A', 3), { mode: 'new' });
    assert.equal(first.completed, 3);
    assert.equal(first.mode, 'new');
    await assert.rejects(load(duckdb, pool, t, rows('B', 2), { mode: 'new' }),
      function(err) { return err.code === 'TARGET_REFUSED' && /already exists\. Choose Append .* or Replace/.test(err.message); });
    assert.equal(await count(duckdb, pool, t), 3);
  } finally { await duckdb.close(pool); }
});

test('Append: adds to the table; to a table that does not exist it is refused (a typo is not a new table)', async function() {
  var pool = await duckdb.connect({ file: ':memory:', access: 'rw' });
  var t = tempTable();
  try {
    await load(duckdb, pool, t, rows('A', 3), { mode: 'new' });
    var added = await load(duckdb, pool, t, rows('B', 2), { mode: 'append' });
    assert.equal(added.completed, 2);
    assert.equal(await count(duckdb, pool, t), 5);
    await assert.rejects(load(duckdb, pool, t + '_typo', rows('C', 1), { mode: 'append' }),
      function(err) { return err.code === 'TARGET_REFUSED' && /does not exist, so there is nothing to append to/.test(err.message); });
    var tables = (await duckdb.query(pool, "SELECT table_name FROM information_schema.tables WHERE table_name = '" + t + "_typo'")).rows;
    assert.equal(tables.length, 0);
  } finally { await duckdb.close(pool); }
});

test('Replace: the table ends up holding exactly the file — counted as replaced and inserted', async function() {
  var pool = await duckdb.connect({ file: ':memory:', access: 'rw' });
  var t = tempTable();
  try {
    await load(duckdb, pool, t, rows('OLD', 4), { mode: 'new' });
    var r = await load(duckdb, pool, t, rows('NEW', 2), { mode: 'replace' });
    assert.equal(r.mode, 'replace');
    assert.deepEqual(r.merged, { inserted: 2, replaced: 4 });
    assert.deepEqual(await skus(duckdb, pool, t), ['NEW1', 'NEW2']);
    await assert.rejects(load(duckdb, pool, t + '_nope', rows('X', 1), { mode: 'replace' }), /nothing to replace/);
  } finally { await duckdb.close(pool); }
});

test('Replace refuses upsert keys and a range replace — it replaces the whole table', async function() {
  var pool = await duckdb.connect({ file: ':memory:', access: 'rw' });
  try {
    await assert.rejects(load(duckdb, pool, tempTable(), rows('A', 1), { mode: 'replace', primaryKeys: ['sku'] }), /takes no primaryKeys/);
    await assert.rejects(load(duckdb, pool, tempTable(), rows('A', 1), { mode: 'replace', replaceFrom: { column: 'qty' } }), /choose one/);
  } finally { await duckdb.close(pool); }
});

test('Replace stopped midway leaves the table exactly as it was', async function() {
  var pool = await duckdb.connect({ file: ':memory:', access: 'rw' });
  var t = tempTable();
  try {
    await load(duckdb, pool, t, rows('OLD', 3), { mode: 'new' });
    var ctrl = new AbortController();
    await assert.rejects(load(duckdb, pool, t, rows('NEW', 50), { mode: 'replace', signal: ctrl.signal,
      onProgress: function() { ctrl.abort(); } }), function(err) { return err.code === 'STOPPED'; });
    assert.deepEqual(await skus(duckdb, pool, t), ['OLD1', 'OLD2', 'OLD3']);
    var staging = (await duckdb.query(pool, "SELECT table_name FROM information_schema.tables WHERE table_name = '" + t + "__xeplr_staging'")).rows;
    assert.equal(staging.length, 0, 'the staging table is dropped');
  } finally { await duckdb.close(pool); }
});

test('a server database stages only a whole-table Replace — any other staged load is refused before it starts', async function() {
  await assert.rejects(upload({ source: rowsOf([]), driver: postgres, connection: { host: 'unused' }, targetTable: 't',
    movementId: 'm', queue: {}, staged: true }), /staged only to replace a whole table/);
});

test('compareToTable: matched, in the file only (refused), in the table only (left empty, or required)', async function() {
  var pool = await duckdb.connect({ file: ':memory:', access: 'rw' });
  var t = tempTable();
  try {
    await duckdb.query(pool, 'CREATE TABLE ' + duckdb.quoteIdent(t) +
      ' (sku VARCHAR NOT NULL, qty INTEGER, note VARCHAR, code VARCHAR NOT NULL, made VARCHAR NOT NULL DEFAULT \'x\', __xeplr_movement_id__ VARCHAR)');
    var c = await compareToTable({ driver: duckdb, connection: pool, targetTable: t, columns: ['sku', 'qty', 'Remarks', ''] });
    assert.equal(c.exists, true);
    assert.deepEqual(c.matched, ['sku', 'qty']);
    assert.deepEqual(c.extra, ['Remarks']);
    assert.deepEqual(c.missing, [{ name: 'note', required: false }, { name: 'code', required: true }, { name: 'made', required: false }]);
    var none = await compareToTable({ driver: duckdb, connection: pool, targetTable: t + '_none', columns: ['sku'] });
    assert.deepEqual(none, { exists: false, matched: [], extra: [], missing: [] });
  } finally { await duckdb.close(pool); }
});

test('formats.columnsOf: a file\'s columns from its first row', async function() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cols-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.csv'), 'sku,qty,note\nA,1,x\nB,2,y\n');
    fs.writeFileSync(path.join(dir, 'empty.csv'), '');
    assert.deepEqual(await formats.columnsOf('csv', path.join(dir, 'a.csv')), ['sku', 'qty', 'note']);
    assert.deepEqual(await formats.columnsOf('csv', path.join(dir, 'empty.csv')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Postgres: the staged Replace on a server database ───────────────────
var PG = process.env.PG_HOST ? { host: process.env.PG_HOST, port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER, password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE || 'postgres' } : null;
var noPg = PG ? false : 'PG_HOST not set — no Postgres';

test('Postgres Replace: one transaction; rows the table refuses are refused while staged and recorded', { skip: noPg }, async function() {
  var pool = await postgres.connect(PG);
  var t = tempTable();
  var q = postgres.quoteIdent;
  try {
    await postgres.query(pool, 'CREATE TABLE ' + q(t) + ' (sku TEXT NOT NULL, qty INTEGER CHECK (qty >= 0))');
    await load(postgres, pool, t, rows('OLD', 3), { mode: 'append' });
    var file = rows('NEW', 5);
    file[2].qty = -1;   // NEW3: the CHECK refuses it — in staging, as one row
    var r = await load(postgres, pool, t, file, { mode: 'replace' });
    assert.deepEqual(r.merged, { inserted: 4, replaced: 3 });
    assert.equal(r.dropped, 1);
    assert.deepEqual(r.errorRows, { recorded: 1, notRecorded: 0 });
    assert.deepEqual(await skus(postgres, pool, t), ['NEW1', 'NEW2', 'NEW4', 'NEW5']);
    var refused = (await postgres.query(pool, 'SELECT row_num, raw_row FROM ' + q(t + '_import_errors'))).rows;
    assert.equal(refused.length, 1);
    assert.equal(refused[0].row_num, 3);
    var staging = (await postgres.query(pool, "SELECT to_regclass($1) AS t", [t + '__xeplr_staging'])).rows[0].t;
    assert.equal(staging, null, 'the staging table is dropped after the move');
  } finally {
    await postgres.query(pool, 'DROP TABLE IF EXISTS ' + q(t + '__xeplr_staging')).catch(function() {});
    await postgres.query(pool, 'DROP TABLE IF EXISTS ' + q(t + '_import_errors')).catch(function() {});
    await postgres.query(pool, 'DROP TABLE IF EXISTS ' + q(t)).catch(function() {});
    await postgres.close(pool);
  }
});

test('Postgres Replace stopped midway: the table keeps its rows', { skip: noPg }, async function() {
  var pool = await postgres.connect(PG);
  var t = tempTable();
  var q = postgres.quoteIdent;
  try {
    await load(postgres, pool, t, rows('OLD', 2), { mode: 'new' });
    var ctrl = new AbortController();
    await assert.rejects(load(postgres, pool, t, rows('NEW', 40), { mode: 'replace', signal: ctrl.signal,
      onProgress: function() { ctrl.abort(); } }), function(err) { return err.code === 'STOPPED'; });
    assert.deepEqual(await skus(postgres, pool, t), ['OLD1', 'OLD2']);
  } finally {
    await postgres.query(pool, 'DROP TABLE IF EXISTS ' + q(t + '__xeplr_staging')).catch(function() {});
    await postgres.query(pool, 'DROP TABLE IF EXISTS ' + q(t + '_import_errors')).catch(function() {});
    await postgres.query(pool, 'DROP TABLE IF EXISTS ' + q(t)).catch(function() {});
    await postgres.close(pool);
  }
});

test('Postgres: a column that takes no empty value and has no default is required; an identity is not', { skip: noPg }, async function() {
  var pool = await postgres.connect(PG);
  var t = tempTable();
  try {
    await postgres.query(pool, 'CREATE TABLE ' + postgres.quoteIdent(t) +
      ' (id BIGSERIAL PRIMARY KEY, sku TEXT NOT NULL, note TEXT, made TEXT NOT NULL DEFAULT \'x\')');
    var c = await compareToTable({ driver: postgres, connection: PG, targetTable: t, columns: ['note'] });
    assert.deepEqual(c.missing, [{ name: 'id', required: false }, { name: 'sku', required: true }, { name: 'made', required: false }]);
  } finally {
    await postgres.query(pool, 'DROP TABLE IF EXISTS ' + postgres.quoteIdent(t)).catch(function() {});
    await postgres.close(pool);
  }
});

test('Postgres Replace whose final move fails: the transaction is undone and the table keeps its rows', { skip: noPg }, async function() {
  var pool = await postgres.connect(PG);
  var t = tempTable();
  var parent = t + '_parent';
  var q = postgres.quoteIdent;
  try {
    // A foreign key is not copied to the staging table (LIKE leaves it), so a
    // row pointing at no parent stages fine and fails only in the move.
    await postgres.query(pool, 'CREATE TABLE ' + q(parent) + ' (code TEXT PRIMARY KEY)');
    await postgres.query(pool, 'INSERT INTO ' + q(parent) + " VALUES ('P1')");
    await postgres.query(pool, 'CREATE TABLE ' + q(t) + ' (sku TEXT, code TEXT REFERENCES ' + q(parent) + ' (code))');
    await load(postgres, pool, t, [{ sku: 'OLD1', code: 'P1' }, { sku: 'OLD2', code: 'P1' }], { mode: 'append' });
    await assert.rejects(load(postgres, pool, t, [{ sku: 'NEW1', code: 'P1' }, { sku: 'NEW2', code: 'NOPE' }], { mode: 'replace' }),
      /foreign key/i);
    assert.deepEqual(await skus(postgres, pool, t), ['OLD1', 'OLD2']);
  } finally {
    for (var x of [t + '__xeplr_staging', t + '_import_errors', t, parent]) {
      await postgres.query(pool, 'DROP TABLE IF EXISTS ' + q(x)).catch(function() {});
    }
    await postgres.close(pool);
  }
});

test('Postgres mergeStaged moves only a whole-table replace', { skip: noPg }, async function() {
  var pool = await postgres.connect(PG);
  try {
    await assert.rejects(postgres.mergeStaged(pool, { targetTable: 't', columns: [], primaryKeys: ['k'] }),
      /replaces the whole table here/);
  } finally { await postgres.close(pool); }
});

test('a Replace is recorded as one, and its rollback is refused — the old rows are gone', { skip: noPg }, async function() {
  var knexLib = require('knex');
  var { bootstrapConfigDb } = require('@xeplr/db');
  var makeKnexMetaStore = require('../lib/uploader/meta-store-knex');
  var { rollback } = require('../lib/uploader');
  var CONFIG_DB = 'xeplr_config_modes_test';
  var server = { host: PG.host, port: PG.port, user: PG.user, password: PG.password };
  var admin = knexLib({ client: 'pg', connection: Object.assign({}, server, { database: 'postgres' }), pool: { min: 0, max: 1 } });
  await admin.raw('DROP DATABASE IF EXISTS ' + CONFIG_DB);
  var boot = await bootstrapConfigDb({ connection: server, database: CONFIG_DB, seed: false });
  var store = makeKnexMetaStore(boot.db, { service: 'xeplr-actions-test', applicationId: 'xeplr-test-app' });
  var pool = await postgres.connect(PG);
  var t = tempTable();
  try {
    await load(postgres, pool, t, rows('OLD', 2), { mode: 'new', metaStore: store });
    var r = await load(postgres, pool, t, rows('NEW', 2), { mode: 'replace', metaStore: store });
    var meta = await store.getById(r.movementId);
    assert.equal((typeof meta.meta === 'string' ? JSON.parse(meta.meta) : meta.meta).mode, 'replace');
    await assert.rejects(rollback({ movementId: r.movementId, driver: postgres, connection: pool, targetTable: t, metaStore: store }),
      /replaced the table's rows .* cannot be rolled back/);
    assert.deepEqual(await skus(postgres, pool, t), ['NEW1', 'NEW2']);
  } finally {
    await postgres.query(pool, 'DROP TABLE IF EXISTS ' + postgres.quoteIdent(t + '_import_errors')).catch(function() {});
    await postgres.query(pool, 'DROP TABLE IF EXISTS ' + postgres.quoteIdent(t)).catch(function() {});
    await postgres.close(pool);
    await boot.db.destroy();
    await admin.raw('DROP DATABASE IF EXISTS ' + CONFIG_DB);
    await admin.destroy();
  }
});

// ── MySQL: the same, on the database most imports here go to ───────────
var MY = process.env.MYSQL_HOST ? { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: 'xeplr_actions_test' } : null;
var noMy = MY ? false : 'MYSQL_HOST not set — no MySQL';

async function mysqlPool() {
  var admin = await require('mysql2/promise').createConnection({ host: MY.host, port: MY.port, user: MY.user, password: MY.password });
  await admin.query('CREATE DATABASE IF NOT EXISTS xeplr_actions_test');
  await admin.end();
  return mysql.connect(MY);
}

async function dropAll(driver, pool, names) {
  for (var x of names) await driver.query(pool, 'DROP TABLE IF EXISTS ' + driver.quoteIdent(x)).catch(function() {});
}

test('MySQL Replace: a row the CHECK refuses is refused while staged and recorded; the rest replace the table', { skip: noMy }, async function() {
  var pool = await mysqlPool();
  var t = tempTable();
  try {
    await mysql.query(pool, 'CREATE TABLE ' + mysql.quoteIdent(t) + ' (sku VARCHAR(20) NOT NULL, qty INT, CHECK (qty >= 0))');
    await load(mysql, pool, t, rows('OLD', 3), { mode: 'append' });
    var file = rows('NEW', 4);
    file[1].qty = -1;
    var r = await load(mysql, pool, t, file, { mode: 'replace' });
    assert.deepEqual(r.merged, { inserted: 3, replaced: 3 });
    assert.deepEqual(r.errorRows, { recorded: 1, notRecorded: 0 });
    assert.deepEqual(await skus(mysql, pool, t), ['NEW1', 'NEW3', 'NEW4']);
    var staging = (await mysql.query(pool, "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t + '__xeplr_staging'])).rows[0].n;
    assert.equal(Number(staging), 0);
  } finally {
    await dropAll(mysql, pool, [t + '__xeplr_staging', t + '_import_errors', t]);
    await mysql.close(pool);
  }
});

test('MySQL Replace whose final move fails is undone; one stopped midway never touches the table', { skip: noMy }, async function() {
  var pool = await mysqlPool();
  var t = tempTable();
  var parent = t + '_p';
  var q = mysql.quoteIdent;
  try {
    // CREATE TABLE … LIKE leaves foreign keys behind, so this row stages and
    // fails only in the move.
    await mysql.query(pool, 'CREATE TABLE ' + q(parent) + ' (code VARCHAR(10) PRIMARY KEY)');
    await mysql.query(pool, 'INSERT INTO ' + q(parent) + " VALUES ('P1')");
    await mysql.query(pool, 'CREATE TABLE ' + q(t) + ' (sku VARCHAR(20), code VARCHAR(10), FOREIGN KEY (code) REFERENCES ' + q(parent) + ' (code))');
    await load(mysql, pool, t, [{ sku: 'OLD1', code: 'P1' }], { mode: 'append' });
    await assert.rejects(load(mysql, pool, t, [{ sku: 'NEW1', code: 'P1' }, { sku: 'NEW2', code: 'NOPE' }], { mode: 'replace' }), /foreign key/i);
    assert.deepEqual(await skus(mysql, pool, t), ['OLD1']);

    var ctrl = new AbortController();
    await assert.rejects(load(mysql, pool, t, new Array(40).fill(0).map(function(_, i) { return { sku: 'S' + i, code: 'P1' }; }),
      { mode: 'replace', signal: ctrl.signal, onProgress: function() { ctrl.abort(); } }), function(err) { return err.code === 'STOPPED'; });
    assert.deepEqual(await skus(mysql, pool, t), ['OLD1']);
  } finally {
    await dropAll(mysql, pool, [t + '__xeplr_staging', t + '_import_errors', t, parent]);
    await mysql.close(pool);
  }
});

test('MySQL: NOT NULL with no default is required; auto-increment and a default are not', { skip: noMy }, async function() {
  var pool = await mysqlPool();
  var t = tempTable();
  try {
    await mysql.query(pool, 'CREATE TABLE ' + mysql.quoteIdent(t) +
      " (id BIGINT AUTO_INCREMENT PRIMARY KEY, sku VARCHAR(20) NOT NULL, note TEXT, made VARCHAR(5) NOT NULL DEFAULT 'x')");
    var c = await compareToTable({ driver: mysql, connection: pool, targetTable: t, columns: ['note', 'Remarks'] });
    assert.deepEqual(c.extra, ['Remarks']);
    assert.deepEqual(c.missing, [{ name: 'id', required: false }, { name: 'sku', required: true }, { name: 'made', required: false }]);
  } finally {
    await dropAll(mysql, pool, [t]);
    await mysql.close(pool);
  }
});
