// The two CSV pain points that eat weeks of dev time:
//   1. Delimiters (commas) inside quoted fields
//   2. Newlines inside quoted fields
// Both handled correctly by csv-parse's state machine.
//
// Run:  node --test test/formats/csv-gnarly.test.js

var test = require('node:test');
var assert = require('node:assert');
var { Readable } = require('stream');
var csv = require('../../lib/formats/csv');

function streamFrom(text) {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

async function collect(iter) {
  var out = [];
  for await (var row of iter) out.push(row);
  return out;
}

test('commas inside quoted fields are content, not separators', async function() {
  var text = [
    'name,description,price',
    '"Widget A","10, 20, or 30 count",42',
    '"Widget B","comma, comma, comma",7',
    'Simple,"no commas here",99'
  ].join('\n');

  var rows = await collect(csv.parseStream(streamFrom(text), {}));
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].name,        'Widget A');
  assert.strictEqual(rows[0].description, '10, 20, or 30 count');
  assert.strictEqual(rows[0].price,       42);
  assert.strictEqual(rows[1].description, 'comma, comma, comma');
});

test('newlines inside quoted fields are content, not row boundaries', async function() {
  var text = 'id,notes\n1,"line one\nline two\nline three"\n2,"single line"\n';

  var rows = await collect(csv.parseStream(streamFrom(text), {}));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].id, 1);
  assert.strictEqual(rows[0].notes, 'line one\nline two\nline three');
  assert.strictEqual(rows[1].notes, 'single line');
});

test('CRLF (Windows) line endings inside quotes preserved as-is', async function() {
  var text = 'id,notes\r\n1,"first\r\nsecond"\r\n2,"third"\r\n';

  var rows = await collect(csv.parseStream(streamFrom(text), {}));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].notes, 'first\r\nsecond');
});

test('escaped double quotes ("") inside quoted fields', async function() {
  var text = 'id,quote\n1,"She said ""hello"" today"\n2,"nested ""quotes"" with, commas"\n';

  var rows = await collect(csv.parseStream(streamFrom(text), {}));
  assert.strictEqual(rows[0].quote, 'She said "hello" today');
  assert.strictEqual(rows[1].quote, 'nested "quotes" with, commas');
});

test('all three horrors combined in one file', async function() {
  var text = [
    'sku,name,description',
    '"S-01","Widget ""Pro""","comma, then\nnewline, then ""quote"""',
    'S-02,Basic,plain'
  ].join('\n');

  var rows = await collect(csv.parseStream(streamFrom(text), {}));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].sku,         'S-01');
  assert.strictEqual(rows[0].name,        'Widget "Pro"');
  assert.strictEqual(rows[0].description, 'comma, then\nnewline, then "quote"');
  assert.strictEqual(rows[1].sku,         'S-02');
});

test('semicolon delimiter with commas in data (common in European locales)', async function() {
  var text = 'sku;description\nA;"€1,50 each"\nB;"€2,25 each"\n';

  var rows = await collect(csv.parseStream(streamFrom(text), { delimiter: ';' }));
  assert.strictEqual(rows[0].description, '€1,50 each');
  assert.strictEqual(rows[1].description, '€2,25 each');
});

test('BOM: UTF-8 byte-order mark at file start is stripped (Windows Excel exports)', async function() {
  // ﻿ is the BOM. Without stripping, the first header becomes
  // '﻿sku' and every downstream lookup by 'sku' silently misses.
  var text = '﻿sku,name,price\nA-1,Widget,10\nA-2,Gadget,20';

  var rows = await collect(csv.parseStream(streamFrom(text), {}));
  assert.strictEqual(rows.length, 2);
  // The key should be 'sku', not '﻿sku'
  assert.deepStrictEqual(Object.keys(rows[0]), ['sku', 'name', 'price']);
  assert.strictEqual(rows[0].sku, 'A-1');
});
