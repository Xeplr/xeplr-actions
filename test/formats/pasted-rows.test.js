// ROWS PASTED INTO ONE CELL, found and put back — on a real .xlsx written the
// way Excel writes it (a line break inside a cell saved as `_x000D_` + a real
// newline, in sharedStrings), read by the real streaming reader.
//
// The sheet reproduces what an ERP paste did to a client's file: row 2's
// Description holds its own remaining columns, two whole rows, and the start
// of a third — whose remaining columns sit in row 2's later cells. The quote
// that opened the paste (`"Cable lug`) and the one that closed it (`brush 4"`)
// were eaten.
//
// The end-to-end case loads it through the file-upload action into a real
// Postgres (PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE); without one it
// says so and is skipped.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var fflate = require('fflate');

var formats = require('../../lib/formats');
var { decodeOoxml, splitPastedRows, expandPastedRows } = formats.pastedRows;

var esc = function(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };

// A minimal .xlsx, cells as shared strings or numbers, the way Excel stores them.
function writeXlsx(file, rows, extraSi) {
  var strings = [];
  var idx = function(s) { var i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  var col = function(i) { return String.fromCharCode(65 + i); };
  // Every string first, so a cell can point at the extra one, which goes last.
  rows.forEach(function(r) { r.forEach(function(v) { if (typeof v === 'string') idx(v); }); });
  var extraIndex = strings.length;
  var sheetRows = rows.map(function(r, ri) {
    return '<row r="' + (ri + 1) + '">' + r.map(function(v, ci) {
      var ref = col(ci) + (ri + 1);
      if (v === null) return '';
      if (typeof v === 'number') return '<c r="' + ref + '"><v>' + v + '</v></c>';
      if (v && v.extra) return '<c r="' + ref + '" t="s"><v>' + extraIndex + '</v></c>';
      return '<c r="' + ref + '" t="s"><v>' + idx(v) + '</v></c>';
    }).join('') + '</row>';
  }).join('');
  var si = strings.map(function(s) { return '<si><t xml:space="preserve">' + esc(s) + '</t></si>'; }).join('') + (extraSi || '');
  var count = strings.length + (extraSi ? 1 : 0);
  var files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Costing" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sheetRows + '</sheetData></worksheet>',
    'xl/sharedStrings.xml': '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + count + '" uniqueCount="' + count + '">' + si + '</sst>'
  };
  var zipped = {};
  Object.keys(files).forEach(function(k) { zipped[k] = fflate.strToU8(files[k]); });
  fs.writeFileSync(file, fflate.zipSync(zipped));
}

// Excel's own way of saving a line break inside a cell: _x000D_ then a newline.
var BR = '_x000D_\n';
var HEADERS = ['Entry_No', 'Description', 'Item_No', 'Quantity', 'Department'];
var PASTED = 'Cable lug' + '\tSPEL186\t-1000\tROLLING MILL' + BR +
  '2904101\tUniform trouser & shirt\tGSAD635\t-42\tSAFETY' + BR +
  '2904102\tHikvision 4MP camera\tGSIT331\t-1\tIT' + BR +
  '2904103\tPainting brush 4';
var SHEET = [
  HEADERS,
  [2904099, 'Scrap dust', 'RMSC268', 300, 'UTILITY'],
  // The paste: its own description, its other columns, two whole rows, and
  // the start of the last row — whose code, quantity and department follow.
  [2904100, PASTED, 'GSCV331', -2, 'CONSTRUCTION'],
  [2904104, 'Line one' + BR + 'line two of a real note', 'NOTE001', 1, 'IT'],
  [2904105, 'Weird\tbut' + BR + 'not rows', 'ODD001', 1, 'IT'],
  [2904106, 'Says _x005F_x000D_ literally', 'LIT001', 1, 'IT']
];

// Inside the tenant's own folder: a local file is read only from there.
var dir = fs.mkdtempSync(path.join(require('../../lib/dataDir').tenantFolder(), 'pasted-'));
var FILE = path.join(dir, 'costing.xlsx');
// A Japanese cell with its furigana (<rPh>): the reading is not the value.
writeXlsx(FILE, SHEET.concat([[2904107, { extra: true }, 'JP001', 1, 'IT']]),
  '<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si>');

async function all(iter) { var out = []; for await (var r of iter) out.push(r); return out; }

test("Excel's escapes decode — a line break, and an escaped escape stays literal", function() {
  assert.strictEqual(decodeOoxml('a_x000D_\nb'), 'a\r\nb');
  assert.strictEqual(decodeOoxml('Says _x005F_x000D_ literally'), 'Says _x000D_ literally');
  assert.strictEqual(decodeOoxml(42), 42);
});

test('the reader decodes line breaks inside cells, and leaves furigana out', async function() {
  var rows = await all(formats.getFormat('excel').parsePath(FILE, {}));
  var note = rows.find(function(r) { return r.Entry_No === 2904104; });
  assert.strictEqual(note.Description, 'Line one\r\nline two of a real note', 'no literal _x000D_');
  assert.strictEqual(rows.find(function(r) { return r.Entry_No === 2904106; }).Description, 'Says _x000D_ literally');
  assert.strictEqual(rows.find(function(r) { return r.Entry_No === 2904107; }).Description, '東京', 'the furigana reading is not joined to the text');
});

test('a cell holding pasted rows is found, without changing anything', async function() {
  var found = await formats.scanPastedRows('excel', FILE, {});
  assert.strictEqual(found.cells, 1);
  assert.strictEqual(found.rows, 3, 'three rows are folded into it');
  assert.deepStrictEqual(found.examples.map(function(e) { return [e.row, e.column, e.rows]; }), [[2, 'Description', 3]]);
});

test('a long scan says how far it has read, and stops when asked', async function() {
  // A CSV big enough to take more than one read of the stream.
  var csv = path.join(dir, 'long.csv');
  var lines = ['Entry_No,Description'];
  for (var i = 1; i <= 60000; i++) lines.push(i + ',Item number ' + i);
  fs.writeFileSync(csv, lines.join('\n') + '\n');
  var bytes = fs.statSync(csv).size;

  var heard = [];
  var found = await formats.scanPastedRows('csv', csv, { onProgress: function(p) { heard.push(p); } });
  assert.strictEqual(found.cells, 0);
  var last = heard[heard.length - 1];
  assert.deepStrictEqual(last, { rowsRead: 60000, bytesRead: bytes, bytes: bytes }, 'the last word is the whole file');

  var controller = new AbortController();
  var seen = 0;
  var stopped = await formats.scanPastedRows('csv', csv, {
    signal: controller.signal,
    onProgress: function() { seen++; }
  }).then(function() { return null; }, function(err) { return err; });
  assert.strictEqual(stopped, null, 'not stopped when nobody asked');
  controller.abort();
  var err = await formats.scanPastedRows('csv', csv, { signal: controller.signal }).catch(function(e) { return e; });
  assert.strictEqual(err && err.code, 'ABORTED', 'a stopped scan throws ABORTED');
  assert.ok(seen >= 1);

  // A row limit. Within it: scanned whole. Over it: skipped, nothing scanned.
  var est60 = await formats.estimateRows(csv);
  assert.ok(Math.abs(est60 - 60001) < 60001 * 0.02, 'estimated close to its 60,001 lines (' + est60 + ')');
  var small = path.join(dir, 'small.csv');
  fs.writeFileSync(small, 'a,b\n1,2\n3,4');
  assert.strictEqual(await formats.estimateRows(small), 3, 'a file under 1 MB is counted exactly, a last line without a newline too');
  fs.writeFileSync(small, '');
  assert.strictEqual(await formats.estimateRows(small), 0);
  var within = await formats.scanPastedRows('csv', csv, { maxRows: 70000 });
  assert.strictEqual(within.tooMany, undefined, 'within the limit: checked whole');
  var skipHeard = [];
  var skipped = await formats.scanPastedRows('csv', csv, { maxRows: 1000, onProgress: function(p) { skipHeard.push(p); } });
  assert.deepStrictEqual(skipped, { cells: 0, rows: 0, examples: [], tooMany: true }, 'over it: not checked');
  assert.strictEqual(skipHeard.length, 0, 'and not a row was read');

  // A big file: estimated from its first MB, skipped without reading the rest.
  var big = path.join(dir, 'big.csv');
  var out = fs.openSync(big, 'w');
  var line = '';
  for (var b = 0; b < 2000; b++) line += b + ',Item number ' + b + '\n';
  for (var rep = 0; rep < 800; rep++) fs.writeSync(out, line);   // 1.6 million rows, ~40 MB
  fs.closeSync(out);
  var est = await formats.estimateRows(big);
  assert.ok(Math.abs(est - 1600000) < 1600000 * 0.05, 'estimated within 5% from the first MB (' + est + ')');
  var t0 = Date.now();
  var bigSkip = await formats.scanPastedRows('csv', big, { maxRows: 1000000 });
  assert.strictEqual(bigSkip.tooMany, true);
  assert.ok(Date.now() - t0 < 500, 'skipped at once (' + (Date.now() - t0) + ' ms)');

  // An estimate that is low still stops at the limit: a short first MB, then long rows... here, the reverse — a
  // file whose first MB has long lines and the rest short ones, so it is estimated under the limit.
  var tricky = path.join(dir, 'tricky.csv');
  var tf = fs.openSync(tricky, 'w');
  var longLine = 'x'.repeat(2000) + '\n';
  for (var l = 0; l < 600; l++) fs.writeSync(tf, longLine);         // ~1.2 MB of long lines
  var shortLines = '';
  for (var sl = 0; sl < 10000; sl++) shortLines += 's\n';
  for (var r2 = 0; r2 < 120; r2++) fs.writeSync(tf, shortLines);    // 1.2 million short rows
  fs.closeSync(tf);
  assert.ok((await formats.estimateRows(tricky)) < 1000000, 'estimated under the limit');
  var stopped2 = await formats.scanPastedRows('csv', tricky, { maxRows: 1000000 });
  assert.deepStrictEqual(stopped2, { cells: 0, rows: 0, examples: [], tooMany: true }, '...yet stopped at the limit, not checked');

  // Excel is read by path: rows are counted, bytes are not known.
  var xl = [];
  await formats.scanPastedRows('excel', FILE, { onProgress: function(p) { xl.push(p); } });
  assert.strictEqual(xl[xl.length - 1].bytesRead, null);
  assert.strictEqual(xl[xl.length - 1].rowsRead, 6);
});

test('...and put back: every row whole, in order, the eaten quotes restored', async function() {
  var rows = await all(expandPastedRows(formats.getFormat('excel').parsePath(FILE, {})));
  assert.deepStrictEqual(rows.map(function(r) { return r.Entry_No; }),
    [2904099, 2904100, 2904101, 2904102, 2904103, 2904104, 2904105, 2904106, 2904107], 'no row lost, none doubled');
  var byEntry = {};
  rows.forEach(function(r) { byEntry[r.Entry_No] = r; });
  assert.deepStrictEqual(byEntry[2904100], { Entry_No: 2904100, Description: '"Cable lug', Item_No: 'SPEL186', Quantity: -1000, Department: 'ROLLING MILL' },
    'the merged row keeps its own first columns and gets its own rest back');
  assert.deepStrictEqual(byEntry[2904102], { Entry_No: 2904102, Description: 'Hikvision 4MP camera', Item_No: 'GSIT331', Quantity: -1, Department: 'IT' });
  assert.deepStrictEqual(byEntry[2904103], { Entry_No: 2904103, Description: 'Painting brush 4"', Item_No: 'GSCV331', Quantity: -2, Department: 'CONSTRUCTION' },
    'the last row takes the merged row\'s later columns, and its inch mark');
});

test('ordinary multi-line text is never "repaired"', function() {
  var note = { Entry_No: 1, Description: 'Line one\r\nline two', Item_No: 'X', Quantity: 1, Department: 'IT' };
  assert.strictEqual(splitPastedRows(note, HEADERS), null, 'no tabs');
  var odd = { Entry_No: 1, Description: 'Weird\tbut\r\nnot rows', Item_No: 'X', Quantity: 1, Department: 'IT' };
  assert.strictEqual(splitPastedRows(odd, HEADERS), null, 'tabs, but not the counts of whole rows');
});

// ── through the file-upload action, into a real Postgres ─────────────────
var PG = process.env.PG_HOST ? {
  host: process.env.PG_HOST, port: Number(process.env.PG_PORT || 5432), user: process.env.PG_USER,
  password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE || 'postgres'
} : null;

test('loaded with the repair on: Postgres holds every row; off: the merged row as it was', { skip: PG ? false : 'PG_HOST not set — no Postgres to load into' }, async function() {
  var { runAction } = require('../../lib/runner');
  var fileUpload = require('../../lib/builtins/file/upload');
  var driver = require('../../lib/drivers/db/postgres');
  var pool = await driver.connect(PG);
  var load = async function(table, repair) {
    var r = await runAction({ action: fileUpload, input: {
      sourceType: 'local', sourcePath: FILE, format: 'excel', formatConfig: repair ? { repairPastedRows: true } : {},
      dbType: 'postgres', dbConnection: PG, targetTable: table
    } });
    assert.strictEqual(r.status, 'success', JSON.stringify(r.error));
    return r;
  };
  var t1 = 'pasted_on_' + Date.now().toString(36), t2 = 'pasted_off_' + Date.now().toString(36);
  try {
    var on = await load(t1, true);
    var got = (await driver.query(pool, 'SELECT "Entry_No", "Description", "Item_No" FROM ' + t1 + ' ORDER BY "Entry_No"', [])).rows;
    assert.strictEqual(got.length, 9, 'all nine rows');
    assert.strictEqual(got.find(function(r) { return Number(r.Entry_No) === 2904103; }).Description, 'Painting brush 4"');
    assert.deepStrictEqual(on.output.repairedPastedRows && [on.output.repairedPastedRows.cells, on.output.repairedPastedRows.rows], [1, 3],
      'the result says what was put back');
    await load(t2, false);
    var off = (await driver.query(pool, 'SELECT count(*)::int AS n FROM ' + t2, [])).rows[0].n;
    assert.strictEqual(off, 6, 'off: loaded as the file has it — six rows, the merge included');
  } finally {
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + t1, []).catch(function() {});
    await driver.query(pool, 'DROP TABLE IF EXISTS ' + t2, []).catch(function() {});
    await driver.close(pool);
  }
});

test('...also when the closing quote was in a later column of the last row', function() {
  // The last row's quote closed in Item_No ("3/4" FITTING"), so the cell holds
  // its Entry_No, Description and Item_No; its Quantity and Department sit in
  // the merged row's cells right after Description, the rest empty.
  var rec = { Entry_No: 10, Description: 'Bolt' + '\tB-1\t5\tSTORE' + BR + '11\tPipe 3/4', Item_No: -3, Quantity: 'PLUMBING', Department: null };
  var split = splitPastedRows(rec, HEADERS);
  assert.ok(split, 'recognised');
  assert.deepStrictEqual(split.rows[1], { Entry_No: 11, Description: 'Pipe 3/4"', Item_No: -3, Quantity: 'PLUMBING', Department: null },
    'closed in Description: the last row\'s Item_No and Quantity are the merged row\'s cells after it');
  var later = { Entry_No: 10, Description: 'Bolt' + '\tB-1\t5\tSTORE' + BR + '11\tPipe\tP-3/4', Item_No: -3, Quantity: 'PLUMBING', Department: null };
  var s2 = splitPastedRows(later, HEADERS);
  assert.deepStrictEqual(s2.rows[1], { Entry_No: 11, Description: 'Pipe', Item_No: 'P-3/4"', Quantity: -3, Department: 'PLUMBING' },
    'closed in Item_No: Quantity and Department shift in from the cells after Description');
  var notPaste = { Entry_No: 10, Description: 'Bolt' + '\tB-1\t5\tSTORE' + BR + '11\tPipe\tP-3/4', Item_No: -3, Quantity: 'PLUMBING', Department: 'SOMETHING ELSE' };
  assert.strictEqual(splitPastedRows(notPaste, HEADERS), null, 'a value where the shape needs an empty cell: not a paste, left alone');
});
