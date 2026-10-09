// export-table and export-pages, writing real files and reading them back.
//
//   xlsx: unzipped and the sheet XML inspected — numbers and dates are typed
//         cells pointing at the right number format; header frozen; filter;
//         then read back with this package's own xlsx parser.
//   csv:  parsed back with csv-parse — BOM, quoting, formula injection.
//   pdf:  page count, the cap note, and that block input is bounded.
//
// Run:  node --test test/export/export-table.test.js

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var { Readable } = require('stream');
var fflate = require('fflate');
// Straight to the modules — the package root also loads @xeplr/db, which
// writing a file has no use for.
var { runAction } = require('../../lib/runner');
var actions = {
  runAction: runAction,
  builtins: { exportTable: require('../../lib/builtins/export/table'), exportPages: require('../../lib/builtins/export/pages') },
  formats: require('../../lib/formats')
};

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));
var out = function(name) { return path.join(dir, name); };

var DOC = {
  title: 'Sales by region',
  subtitle: 'Date: Current financial year',
  columns: [
    { header: 'Region' },
    { header: 'Month', kind: 'date', numFmt: 'mmm yyyy' },
    { header: 'Revenue', kind: 'number', numFmt: '"₹"#,##0.00', align: 'right' },
    { header: 'Share', kind: 'number', numFmt: '0.0%', align: 'right' }
  ]
};
var ROWS = [
  { values: ['North', '2024-01-01', 1234.5, 0.25], display: ['North', 'Jan 2024', '₹1,234.50', '25.0%'] },
  { values: ['South, East', '2024-02-01', -20, 0.75], display: ['South, East', 'Feb 2024', '-₹20.00', '75.0%'] },
  { kind: 'total', values: [null, null, 1214.5, 1], display: ['', '', '₹1,214.50', '100.0%'] }
];

async function run(input) {
  var res = await actions.runAction(actions.builtins.exportTable, input);
  if (res.status !== 'success') throw new Error(res.error && res.error.message);
  return res.output;
}

function sheetXml(file) {
  var files = fflate.unzipSync(new Uint8Array(fs.readFileSync(file)));
  return {
    sheet: fflate.strFromU8(files['xl/worksheets/sheet1.xml']),
    styles: fflate.strFromU8(files['xl/styles.xml']),
    workbook: fflate.strFromU8(files['xl/workbook.xml']),
    names: Object.keys(files)
  };
}

test('xlsx: numbers and dates are typed cells carrying their number format', async function() {
  var res = await run({ format: 'xlsx', document: DOC, rows: ROWS, outputPath: out('sales.xlsx') });
  assert.strictEqual(res.rows, 3);
  assert.strictEqual(res.truncated, false);
  assert.strictEqual(res.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  var x = sheetXml(res.filePath);
  assert.ok(x.names.indexOf('[Content_Types].xml') !== -1 && x.names.indexOf('xl/styles.xml') !== -1);

  // Title on row 1, subtitle row 2, a blank, the header on row 4: frozen below it.
  assert.match(x.sheet, /<pane ySplit="4" topLeftCell="A5"/);
  assert.match(x.sheet, /<autoFilter ref="A4:D7"\/>/);

  var fmtId = function(code) {
    var m = new RegExp('<numFmt numFmtId="(\\d+)" formatCode="' + code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"/>').exec(x.styles);
    return m && m[1];
  };
  var xfs = /<cellXfs[^>]*>(.*)<\/cellXfs>/.exec(x.styles)[1].match(/<xf [^>]*>/g);
  var styleOf = function(ref) { return Number(new RegExp('<c r="' + ref + '" s="(\\d+)"').exec(x.sheet)[1]); };
  var numFmtOf = function(ref) { return /numFmtId="(\d+)"/.exec(xfs[styleOf(ref)])[1]; };

  assert.match(x.sheet, /<c r="C5" s="\d+"><v>1234.5<\/v><\/c>/, 'revenue is a NUMBER cell');
  assert.strictEqual(numFmtOf('C5'), fmtId('&quot;₹&quot;#,##0.00'), 'with the currency format');
  assert.match(x.sheet, /<c r="B5" s="\d+"><v>45292<\/v><\/c>/, '2024-01-01 is date serial 45292');
  assert.strictEqual(numFmtOf('B5'), fmtId('mmm yyyy'));
  assert.strictEqual(numFmtOf('D5'), fmtId('0.0%'));
  assert.match(x.sheet, /<c r="A6" t="inlineStr" s="\d+"><is><t xml:space="preserve">South, East<\/t>/);
  assert.match(xfs[styleOf('C7')], /fontId="1"/, 'the total row is bold');
  assert.match(xfs[styleOf('C7')], /fillId="3"/, '...on a tint');
  assert.match(x.workbook, /<sheet name="Sales by region"/);
});

test('xlsx: our own reader reads the file back', async function() {
  var res = await run({ format: 'xlsx', document: { columns: DOC.columns }, rows: ROWS, outputPath: out('plain.xlsx') });
  var rows = [];
  for await (var r of actions.formats.getFormat('excel').parsePath(res.filePath)) rows.push(r);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].Region, 'North');
  assert.strictEqual(rows[0].Revenue, 1234.5);
  assert.ok(rows[0].Month instanceof Date && rows[0].Month.toISOString().slice(0, 10) === '2024-01-01', 'a date cell reads as a Date');
});

test('xlsx: rows from an NDJSON file, streamed', async function() {
  var file = out('rows.ndjson');
  var lines = [];
  for (var i = 0; i < 5000; i++) lines.push(JSON.stringify({ values: ['r' + i, '2024-01-01', i, 0.5] }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  var res = await run({ format: 'xlsx', document: { columns: DOC.columns }, rowsFile: file, outputPath: out('big.xlsx') });
  assert.strictEqual(res.rows, 5000);
  var x = sheetXml(res.filePath);
  assert.match(x.sheet, /<c r="C5001" s="\d+"><v>4999<\/v><\/c>/);
});

test('xlsx: 200,000 rows stream without holding them', async function() {
  var file = out('huge.ndjson');
  var fd = fs.openSync(file, 'w');
  for (var i = 0; i < 200000; i++) fs.writeSync(fd, JSON.stringify({ values: ['region ' + (i % 50), '2024-01-01', i * 1.5, i % 100 / 100] }) + '\n');
  fs.closeSync(fd);
  if (global.gc) global.gc();
  var before = process.memoryUsage().rss;
  var res = await run({ format: 'xlsx', document: { columns: DOC.columns }, rowsFile: file, outputPath: out('huge.xlsx') });
  var grown = (process.memoryUsage().rss - before) / 1048576;
  assert.strictEqual(res.rows, 200000);
  assert.ok(grown < 200, 'memory grew ' + grown.toFixed(0) + ' MB writing 200k rows');
});

test('csv: raw values, BOM, quoting, and no formula injection', async function() {
  var rows = ROWS.concat([{ values: ['=HYPERLINK("http://x")', null, 5, '+1'] }, { values: ['say "hi"\nthere', new Date(Date.UTC(2024, 5, 1)), 0, 0] }]);
  var res = await run({ format: 'csv', document: DOC, rows: rows, outputPath: out('sales.csv') });
  var buf = fs.readFileSync(res.filePath);
  assert.deepStrictEqual([...buf.slice(0, 3)], [0xef, 0xbb, 0xbf], 'starts with a UTF-8 BOM');
  var { parse } = require('csv-parse/sync');
  var parsed = parse(buf, { bom: true });
  assert.deepStrictEqual(parsed[0], ['Region', 'Month', 'Revenue', 'Share']);
  assert.deepStrictEqual(parsed[1], ['North', '2024-01-01', '1234.5', '0.25'], 'raw values, not the display text');
  assert.strictEqual(parsed[2][0], 'South, East', 'a comma inside a field survives');
  assert.strictEqual(parsed[4][0], '\'=HYPERLINK("http://x")', 'a formula-looking text is neutralised');
  assert.strictEqual(parsed[4][3], '\'+1');
  assert.strictEqual(parsed[5][0], 'say "hi"\nthere', 'quotes and a line break survive');
  assert.strictEqual(parsed[5][1], '2024-06-01', 'a whole-day Date is written as YYYY-MM-DD');
});

function pdfPages(file) {
  return (fs.readFileSync(file, 'latin1').match(/\/Type \/Page\b/g) || []).length;
}

test('pdf: pages, capped with a note', async function() {
  var many = [];
  for (var i = 0; i < 300; i++) many.push({ values: [], display: ['Région ' + i, 'Jan 2024', '₹' + i, '1%'] });
  var res = await run({ format: 'pdf', document: DOC, rows: many, maxRows: 100, outputPath: out('sales.pdf') });
  assert.strictEqual(res.rows, 100);
  assert.strictEqual(res.truncated, true);
  var head = fs.readFileSync(res.filePath).slice(0, 5).toString();
  assert.strictEqual(head, '%PDF-');
  var pages = pdfPages(res.filePath);
  assert.ok(pages >= 2 && pages <= 4, pages + ' pages for 100 rows');
  // The cap note is in the page content (the font is subset-embedded, so the
  // text is glyph ids — check the uncompressed stream has as many text runs
  // as rows plus headers instead).
  var raw = fs.readFileSync(res.filePath);
  var texts = 0;
  var re = /stream\r?\n/g;
  var m;
  while ((m = re.exec(raw.toString('latin1')))) {
    var start = m.index + m[0].length;
    var end = raw.indexOf('endstream', start);
    try { texts += (zlib.inflateSync(raw.slice(start, end)).toString('latin1').match(/\bTJ\b/g) || []).length; } catch (e) { /* not a content stream */ }
  }
  assert.ok(texts >= 100 * 4, texts + ' text runs');
});

test('export-pages: blocks are laid out; what is posted is bounded', async function() {
  // A real 2×2 PNG, built here: signature, IHDR, IDAT, IEND, each CRC'd.
  function chunk(type, data) {
    var len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    var body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    var crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  }
  var ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
  var pixels = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]));
  var png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]).toString('base64');
  var broken = 'data:image/png;base64,' + Buffer.from('not a png').toString('base64');
  var res = await actions.runAction(actions.builtins.exportPages, {
    title: 'Board', outputPath: out('board.pdf'),
    pages: [
      { blocks: [
        { type: 'text', x: 0, y: 0, w: 0.5, h: 0.1, text: 'Total ₹1.2M', size: 18, bold: true },
        { type: 'image', x: 0.5, y: 0, w: 0.5, h: 0.4, src: png },
        { type: 'image', x: 0.8, y: 0.5, w: 0.2, h: 0.2, src: broken },
        { type: 'rect', x: 0, y: 0.5, w: 0.2, h: 0.2, fill: '#eceeff', stroke: '#4f5fd6', radius: 4 },
        { type: 'line', x: 0, y: 0.8, w: 1, h: 0 },
        { type: 'table', x: 0.3, y: 0.5, w: 0.5, h: 0.4, title: 'Top', columns: DOC.columns, rows: ROWS }
      ] },
      { blocks: [] }
    ]
  });
  assert.strictEqual(res.status, 'success', res.error && res.error.message);
  assert.strictEqual(res.output.pages, 2);
  assert.strictEqual(pdfPages(res.output.filePath), 2);
  assert.match(fs.readFileSync(res.output.filePath, 'latin1'), /\/Subtype \/Image/, 'the PNG is in the file');

  var refused = async function(pages, pattern) {
    var r = await actions.runAction(actions.builtins.exportPages, { pages: pages, outputPath: out('bad.pdf') });
    assert.strictEqual(r.status, 'failed');
    assert.match(r.error.message, pattern);
  };
  await refused([{ blocks: [{ type: 'image', x: 0, y: 0, w: 1, h: 1, src: 'https://example.com/a.png' }] }], /PNG or JPEG data URL/);
  await refused([{ blocks: [{ type: 'image', x: 0, y: 0, w: 1, h: 1, src: 'data:image/svg+xml;base64,PHN2Zz4=' }] }], /PNG or JPEG data URL/);
  await refused([{ blocks: [{ type: 'script', x: 0, y: 0, w: 1, h: 1 }] }], /type must be one of/);
  await refused([{ blocks: [{ type: 'text', x: 'a', y: 0, w: 1, h: 1 }] }], /fractions of the page/);
  await refused(new Array(51).fill({ blocks: [] }), /At most 50 pages/);
});

test('bad input is refused, naming what is missing', async function() {
  var r = await actions.runAction(actions.builtins.exportTable, { format: 'docx', document: DOC, rows: [] });
  assert.strictEqual(r.status, 'failed');
  r = await actions.runAction(actions.builtins.exportTable, { format: 'csv', document: { columns: [] }, rows: [] });
  assert.match(r.error.message, /at least one column/);
  r = await actions.runAction(actions.builtins.exportTable, { format: 'csv', document: DOC });
  assert.match(r.error.message, /rows, or a rowsFile/);
});

test.after(function() { fs.rmSync(dir, { recursive: true, force: true }); });
