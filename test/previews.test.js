// @flags: --require=./test/setup-data-dir.cjs
// A PREVIEW reads what a step would hand on and never does what the step
// does: a few rows from a real folder, a real file and real Postgres; a step
// that writes or sends answers with its example and is not run; a wrong input
// is said, not thrown. previewAction never calls execute on anything that
// writes.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var { previewAction, PREVIEW_ROWS } = require('../lib/runner');
var registry = require('../lib/registry');
var list = require('../lib/builtins/file/list');
var read = require('../lib/builtins/file/read');
var del = require('../lib/builtins/file/delete');
var move = require('../lib/builtins/file/move');
var fetch = require('../lib/builtins/db/fetch');
var listTables = require('../lib/builtins/db/list-tables');
var dataOperation = require('../lib/builtins/data-operation');

var root = require('../lib/dataDir').tenantFolder();
var inbox = path.join(root, 'preview-inbox');
fs.mkdirSync(inbox, { recursive: true });
for (var i = 1; i <= 7; i++) fs.writeFileSync(path.join(inbox, 'f' + i + '.csv'), 'n\n' + i + '\n');
var big = path.join(root, 'preview-big.csv');
fs.writeFileSync(big, 'ref,amount\n' + Array.from({ length: 12 }, function(_, k) { return 'R' + k + ',' + k; }).join('\n') + '\n');

test('the five rows a preview reads', function() {
  assert.equal(PREVIEW_ROWS, 5);
});

test('file-list: the first files, the real count, and the folder untouched', async function() {
  var before = fs.readdirSync(inbox).sort();
  var res = await previewAction(list, { folder: 'preview-inbox' });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.equal(res.output.count, 7);
  assert.equal(res.output.files.length, 5);
  assert.equal(res.rows.length, 5);
  assert.deepEqual(fs.readdirSync(inbox).sort(), before);
});

test('file-read: the file\'s first rows, in the shape a run hands on', async function() {
  var res = await previewAction(read, { path: 'preview-big.csv' });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.equal(res.output.rows.length, 5);
  assert.deepEqual(res.output.columns.map(function(c) { return c.key; }), ['ref', 'amount']);
  assert.equal(res.rows[0].ref, 'R0');
});

test('a step that writes is never run: its example comes back, the file is still there', async function() {
  var target = path.join(inbox, 'f1.csv');
  var res = await previewAction(del, { path: 'preview-inbox/f1.csv' });
  assert.equal(res.status, 'example');
  assert.deepEqual(Object.keys(res.output).sort(), ['deleted', 'path', 'skipped']);
  assert.ok(fs.existsSync(target), 'file-delete did not delete');
  var moved = await previewAction(move, { from: 'preview-inbox/f2.csv', to: 'elsewhere' });
  assert.equal(moved.status, 'example');
  assert.ok(fs.existsSync(path.join(inbox, 'f2.csv')), 'file-move did not move');
});

test('an action with neither a preview nor an example: nothing to show, said plainly', async function() {
  var res = await previewAction({ name: 'plain', inputSchema: [], execute: function() { throw new Error('must not run'); } }, {});
  assert.equal(res.status, 'example');
  assert.equal(res.output, null);
});

test('an incomplete input or a missing action is an answer, never a throw', async function() {
  var res = await previewAction(read, {});
  assert.equal(res.status, 'failed');
  assert.match(res.error.message, /path/);
  var none = await previewAction({ name: 'not-registered-anywhere' });
  assert.equal(none.status, 'failed');
});

test('registered: the list says which can be previewed and carries the example; the function stays here', function() {
  registry.register(list);
  registry.register(del);
  var listed = registry.list();
  var l = listed.find(function(a) { return a.name === 'file-list'; });
  var d = listed.find(function(a) { return a.name === 'file-delete'; });
  assert.equal(l.preview, true);
  assert.equal(d.preview, false);
  assert.equal(d.example.deleted, true);
  assert.equal(typeof registry.get('file-list').preview, 'function');
});

test('data-operation: the run itself, over the rows it is given', async function() {
  var res = await previewAction(dataOperation, { from: [{ a: 1 }, { a: 2 }] });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.equal(res.output.count, 2);
});

var PG = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || process.env.USER, password: process.env.PGPASSWORD, database: 'postgres' };

test('db-fetch and db-list-tables on real Postgres: five rows, no file written', async function(t) {
  var pg = require('../lib/drivers/db/postgres');
  var admin = await pg.connect(PG);
  try { await admin.query('SELECT 1'); } catch (err) { await pg.close(admin); t.skip('no Postgres available (' + err.message + ')'); return; }
  var table = 'xeplr_actions_preview_' + process.pid;
  await admin.query('CREATE TABLE ' + table + ' AS SELECT g AS id, \'r\' || g AS name FROM generate_series(1, 8) g');
  try {
    var tmp = require('../lib/dataDir').scratch();
    var before = fs.existsSync(tmp) ? fs.readdirSync(tmp).length : 0;
    var res = await previewAction(fetch, { dbType: 'postgres', connection: PG, mode: 'table', table: table });
    assert.equal(res.status, 'success', res.error && res.error.message);
    assert.equal(res.rows.length, 5);
    assert.equal(res.rows[0].name, 'r1');
    assert.equal(res.output.streaming, true);
    assert.equal(res.output.format, 'jsonl');
    assert.equal(fs.existsSync(tmp) ? fs.readdirSync(tmp).length : 0, before, 'no file spooled');
    var inline = await previewAction(fetch, { dbType: 'postgres', connection: PG, mode: 'table', table: table, streaming_mode: false });
    assert.equal(inline.output.rows.length, 5);
    assert.equal(inline.output.rowCount, 5);
    var tables = await previewAction(listTables, { dbType: 'postgres', connection: PG });
    assert.equal(tables.status, 'success', tables.error && tables.error.message);
    assert.ok(JSON.stringify(tables.output.tables).indexOf(table) > -1);
  } finally {
    await admin.query('DROP TABLE IF EXISTS ' + table);
    await pg.close(admin);
  }
});
