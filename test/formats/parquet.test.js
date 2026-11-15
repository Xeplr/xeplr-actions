// Parquet, written and read back for real: files on disk, read by DuckDB's
// own Parquet reader (the one pandas-equivalent we have in node), and the
// actions round-tripping through real DuckDB database files.
//
//   writer   parts of partRows, _done last, dot-named while being written,
//            types declared or inferred, a bad value or a stray column
//            refused naming the row, bookkeeping columns left behind
//   reader   a folder as one table, a file, an empty folder
//   actions  export-table parquet, file-upload format parquet
//            (db-fetch → db-push through Parquet: test/builtins/parquet-pg.test.js)
//
// Run:  node --test --require ./test/setup-data-dir.cjs test/formats/parquet.test.js

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var parquet = require('../../lib/formats/parquet');
var duck = require('../../lib/drivers/db/duckdb');
var dataDir = require('../../lib/dataDir');
var { runAction } = require('../../lib/runner');

var root = fs.mkdtempSync(path.join(dataDir.tenantFolder(), 'parquet-test-'));
function place(name) { return path.join(root, name); }
async function* rowsOf(list) { for (var r of list) yield r; }
// An action run that fails throws its error, rather than handing back { status: 'failed' }.
async function run(action, input) {
  var res = await runAction(action, input, { system: {} });
  if (res.status !== 'success') throw res.error || new Error('failed: ' + JSON.stringify(res));
  return res.output;
}
async function all(iterable) { var out = []; for await (var r of iterable) out.push(r); return out; }

// What DuckDB itself reads from the files: the count and each column's type.
async function describe(target) {
  var pool = await duck.connect({ file: ':memory:', access: 'rw' });
  try {
    var src = fs.statSync(target).isDirectory() ? path.join(target, '*.parquet') : target;
    var types = await duck.query(pool, "DESCRIBE SELECT * FROM read_parquet('" + src + "')", []);
    var count = await duck.query(pool, "SELECT count(*) AS n FROM read_parquet('" + src + "')", []);
    var out = { rows: count.rows[0].n, types: {} };
    types.rows.forEach(function(r) { out.types[r.column_name] = r.column_type; });
    return out;
  } finally { await duck.close(pool); }
}

function sample(n) {
  return Array.from({ length: n }, function(_, i) {
    return {
      ref: 'R-' + String(i).padStart(5, '0'),
      amount: i + 0.25,
      paid: i % 2 === 0,
      at: new Date(Date.UTC(2026, 0, 1 + (i % 28), 10, 30)),
      tags: { n: i }
    };
  });
}

test('rows become parts of partRows, then _done, and read back as one table', async function() {
  var dir = place('parts');
  var done = await parquet.writeAll(rowsOf(sample(2500)), { dir: dir, partRows: 1000 });

  assert.deepEqual(done.parts, ['part-00001.parquet', 'part-00002.parquet', 'part-00003.parquet']);
  assert.equal(done.rows, 2500);
  assert.ok(done.bytes > 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['_done', 'part-00001.parquet', 'part-00002.parquet', 'part-00003.parquet']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '_done'), 'utf8')), { rows: 2500, parts: 3 });

  var seen = await describe(dir);
  assert.equal(seen.rows, 2500);
  assert.deepEqual(seen.types, { ref: 'VARCHAR', amount: 'DOUBLE', paid: 'BOOLEAN', at: 'TIMESTAMP WITH TIME ZONE', tags: 'JSON' });

  var back = await all(parquet.readRows(dir));
  assert.equal(back.length, 2500);
  // JSON comes back as its text, as it does from a DuckDB table's JSON column.
  assert.deepEqual(back[1], { ref: 'R-00001', amount: 1.25, paid: false, at: new Date(Date.UTC(2026, 0, 2, 10, 30)), tags: '{"n":1}' });
  assert.deepEqual(await parquet.columnsOf(dir), [
    { name: 'ref', type: 'string' }, { name: 'amount', type: 'number' }, { name: 'paid', type: 'boolean' },
    { name: 'at', type: 'datetime' }, { name: 'tags', type: 'object' }
  ]);
});

test('declared columns win over the values: numeric text is a number, a date a DATE', async function() {
  var dir = place('declared');
  var rows = [{ code: '007', price: '12.50', day: '2026-03-01' }, { code: '010', price: null, day: null }];
  await parquet.writeAll(rowsOf(rows), { dir: dir, columns: [
    { name: 'code', type: 'string' }, { name: 'price', type: 'number' }, { name: 'day', type: 'date' }
  ] });
  var seen = await describe(dir);
  assert.deepEqual(seen.types, { code: 'VARCHAR', price: 'DOUBLE', day: 'DATE' });
  var back = await all(parquet.readRows(dir));
  assert.equal(back[0].code, '007');
  assert.equal(back[0].price, 12.5);
  assert.equal(back[1].price, null);
});

test('a value that does not fit fails the write naming row and column, and leaves no part', async function() {
  var dir = place('bad-value');
  var rows = sample(5).map(function(r) { return { ref: r.ref, amount: r.amount }; });
  rows.push({ ref: 'R-x', amount: 'twelve' });
  await assert.rejects(parquet.writeAll(rowsOf(rows), { dir: dir, scanRows: 3, partRows: 2 }),
    function(err) { return err.code === 'PARQUET_ROW' && /^Row 6: column "amount" \(number\) cannot hold "twelve"/.test(err.message); });
  assert.deepEqual(fs.readdirSync(dir), [], 'the parts already written are removed, and there is no _done');
});

test('a column the first rows did not have is refused, never dropped', async function() {
  var dir = place('stray');
  var rows = [{ a: 1 }, { a: 2 }, { a: 3, b: 'late' }];
  await assert.rejects(parquet.writeAll(rowsOf(rows), { dir: dir, scanRows: 2 }),
    /Row 3: it has a column "b" that the rows before it did not/);
});

test('our bookkeeping columns are left behind', async function() {
  var dir = place('internal');
  await parquet.writeAll(rowsOf([{ __xeplr_id__: 1, __xeplr_movement_id__: 'm1', a: 1 }]), { dir: dir });
  assert.deepEqual(Object.keys((await describe(dir)).types), ['a']);
});

test('no rows: declared columns still give one empty part; none give only _done', async function() {
  var typed = place('empty-typed');
  var done = await parquet.writeAll(rowsOf([]), { dir: typed, columns: [{ name: 'a', type: 'number' }] });
  assert.deepEqual(done.parts, ['part-00001.parquet']);
  assert.deepEqual(await describe(typed), { rows: 0, types: { a: 'DOUBLE' } });

  var bare = place('empty-bare');
  done = await parquet.writeAll(rowsOf([]), { dir: bare });
  assert.deepEqual(fs.readdirSync(bare), ['_done']);
  assert.equal(parquet.isParquet(bare), true);
  assert.deepEqual(await all(parquet.readRows(bare)), []);
  assert.deepEqual(await parquet.columnsOf(bare), []);
});

test('a stop ends the write as STOPPED, leaving nothing', async function() {
  var dir = place('stopped');
  var ac = new AbortController();
  async function* endless() { for (var i = 0; ; i++) { if (i === 1500) ac.abort(); yield { i: i }; } }
  await assert.rejects(parquet.writeAll(endless(), { dir: dir, partRows: 500, signal: ac.signal }), function(err) { return err.code === 'STOPPED'; });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('300,000 rows stream through in parts', async function() {
  var dir = place('large');
  var started = Date.now();
  async function* many() { for (var i = 0; i < 300000; i++) yield { id: i, name: 'row ' + i, value: i * 1.5 }; }
  var done = await parquet.writeAll(many(), { dir: dir });
  assert.equal(done.parts.length, 3);
  assert.equal((await describe(dir)).rows, 300000);
  assert.ok(Date.now() - started < 30000, 'took ' + (Date.now() - started) + ' ms');
});

test('export-table writes one .parquet file, headers made unique', async function() {
  var res = await run(require('../../lib/builtins/export/table'), {
    format: 'parquet', outputPath: place('export.parquet'),
    document: { title: 'Sales', columns: [{ header: 'Region' }, { header: 'Amount' }, { header: 'Amount' }] },
    rows: [{ values: ['North', 10, 11] }, { values: ['South', 20.5, null] }]
  });
  assert.equal(res.contentType, 'application/vnd.apache.parquet');
  assert.equal(res.rows, 2);
  assert.deepEqual(await describe(res.filePath), { rows: 2, types: { Region: 'VARCHAR', Amount: 'DOUBLE', 'Amount (2)': 'DOUBLE' } });
});

test('file-upload and columnsOf take parquet as a source format', async function() {
  var formats = require('../../lib/formats');
  var file = place('upload.parquet');
  await parquet.writeAll(rowsOf([{ a: 1, b: 'x' }]), { file: file });
  assert.ok(formats.SUPPORTED.indexOf('parquet') !== -1);
  assert.deepEqual(await formats.columnsOf('parquet', file), ['a', 'b']);
});
