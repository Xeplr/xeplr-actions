// What a saved file is called, and what happens when the name is taken: the
// one rule every file-writing action follows (lib/fileNames.js).
var assert = require('node:assert');
var { test } = require('node:test');
var fs = require('fs');
var os = require('os');
var path = require('path');
var fileNames = require('../lib/fileNames');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-names-')); }

test('a name from the file\'s own placeholders', function() {
  var p = fileNames.partsOf('statement.CSV');
  assert.deepEqual(p, { original: 'statement.CSV', name: 'statement', ext: 'CSV' });
  // {…} was already filled by the workflow; […] is the file's.
  assert.equal(fileNames.nameFrom('Bank-2026-09-[name].[ext]', { original: p.original, name: p.name, ext: p.ext, n: 1 }), 'Bank-2026-09-statement.CSV');
  assert.equal(fileNames.nameFrom('[n]-[original]', { original: 'a.pdf', n: 2 }), '2-a.pdf');
});

test('a placeholder the file does not have is refused, listing the ones it has', function() {
  assert.throws(function() { fileNames.nameFrom('[orignal]', { original: 'a.pdf', n: 1 }); },
    function(e) { return /uses \[orignal\].*It has: \[original\], \[n\]/.test(e.message) && e.code === 'FILE_NAME_INVALID'; });
});

test('a name can never leave its folder, and an empty one is refused', function() {
  assert.equal(fileNames.nameFrom('../../etc/[original]', { original: 'x' }), '.._.._etc_x');
  assert.equal(fileNames.safeName('a/b\\c:d*e?.pdf'), 'a_b_c_d_e_.pdf');
  assert.equal(fileNames.safeName('Bank  Sep 2026.csv'), 'Bank Sep 2026.csv');
  assert.throws(function() { fileNames.nameFrom('..', {}); }, /comes out empty/);
  assert.throws(function() { fileNames.nameFrom('[original]', { original: '' }); }, /comes out empty/);
});

test('fail (the default): a taken name stops the step before anything is written', function() {
  var dir = tempDir();
  fs.writeFileSync(path.join(dir, 'Bank-2026-09.csv'), 'old');
  assert.throws(function() { fileNames.plan(dir, ['new.csv', 'Bank-2026-09.csv']); },
    function(e) { return e.code === 'FILE_EXISTS' && /"Bank-2026-09.csv" is already in/.test(e.message) && /Nothing was saved/.test(e.message); });
  assert.deepEqual(fileNames.plan(dir, ['new.csv']).map(function(p) { return [p.name, p.write]; }), [['new.csv', true]]);
});

test('skip: listed as not written', function() {
  var dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.pdf'), 'x');
  var p = fileNames.plan(dir, ['a.pdf', 'b.pdf'], 'skip');
  assert.deepEqual(p.map(function(x) { return [x.name, x.write]; }), [['a.pdf', false], ['b.pdf', true]]);
});

test('addSuffix: the next free number, before the extension', function() {
  var dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.pdf'), 'x');
  fs.writeFileSync(path.join(dir, 'a (2).pdf'), 'x');
  assert.deepEqual(fileNames.plan(dir, ['a.pdf', 'a.pdf', 'noext'], 'addSuffix').map(function(x) { return x.name; }), ['a (3).pdf', 'a (4).pdf', 'noext']);
});

test('overwrite: replaced, but two files of one step never overwrite each other', function() {
  var dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.pdf'), 'x');
  assert.deepEqual(fileNames.plan(dir, ['a.pdf', 'a.pdf'], 'overwrite').map(function(x) { return x.name; }), ['a.pdf', 'a (2).pdf']);
});

test('two files of one step with one name, under fail, are refused before writing', function() {
  assert.throws(function() { fileNames.plan(tempDir(), ['same.pdf', 'same.pdf']); }, /"same.pdf" is already in/);
});

test('an ifExists that is not one is refused', function() {
  assert.throws(function() { fileNames.plan(tempDir(), ['a'], 'replace'); }, /ifExists is one of fail, skip, overwrite, addSuffix/);
});

test('both email download steps ask for a name and what to do when it is taken', function() {
  ['../lib/builtins/email/download-attachments', '../lib/builtins/email/download-email'].forEach(function(m) {
    var names = require(m).inputSchema.map(function(f) { return f.name; });
    assert.ok(names.indexOf('fileName') > -1 && names.indexOf('ifExists') > -1, m);
  });
});

var emailFiles = require('../lib/drivers/email/files');

test('attachments: named from the template, per attachment, and checked before writing', function() {
  var dir = tempDir();
  var atts = [{ filename: 'statement.csv' }, { filename: 'summary.pdf' }];
  var places = emailFiles.attachmentPlaces(dir, atts, '42', { fileName: 'Bank-2026-09-[n]-[name].[ext]' });
  assert.deepEqual(places.map(function(p) { return p.name; }), ['Bank-2026-09-1-statement.csv', 'Bank-2026-09-2-summary.pdf']);
  fs.writeFileSync(places[1].path, 'x');
  assert.throws(function() { emailFiles.attachmentPlaces(dir, atts, '42', { fileName: 'Bank-2026-09-[n]-[name].[ext]' }); }, /already in/);
  var skipping = emailFiles.attachmentPlaces(dir, atts, '42', { fileName: 'Bank-2026-09-[n]-[name].[ext]', ifExists: 'skip' });
  assert.deepEqual(skipping.map(function(p) { return p.write; }), [true, false]);
});

test('attachments without a name keep the random prefix', function() {
  var p = emailFiles.attachmentPlaces(tempDir(), [{ filename: 'a.pdf' }], '1', {});
  assert.match(p[0].name, /^[0-9a-f]{10}_a\.pdf$/);
});

test('a whole email: named from its subject and id, or as before', function() {
  var dir = tempDir();
  assert.equal(emailFiles.emlPlace(dir, 'Invoice 7/2026', '9', { fileName: '[id]-[subject].[ext]' }).name, '9-Invoice 7_2026.eml');
  assert.equal(emailFiles.emlPlace(dir, null, '9', { fileName: '[subject].[ext]' }).name, 'message.eml');
  assert.match(emailFiles.emlPlace(dir, 'Hi', '9', {}).name, /^[0-9a-f]{10}_Hi\.eml$/);
  fs.writeFileSync(path.join(dir, 'x.eml'), 'x');
  assert.equal(emailFiles.emlPlace(dir, 'Hi', '9', { fileName: 'x.[ext]', ifExists: 'skip' }).write, false);
});

test('saving a message\'s attachments: filtered, named, written, and the taken ones listed', function() {
  var dir = tempDir();
  var all = [
    { filename: 'statement.csv', content: Buffer.from('a,b'), contentType: 'text/csv' },
    { filename: 'logo.png', content: Buffer.from('png') },
    { filename: 'summary.csv', content: Buffer.from('c') }
  ];
  var input = { extension: 'csv', fileName: 'Bank-[n].[ext]' };
  var first = emailFiles.saveAttachments(dir, all, '7', input);
  assert.equal(first.count, 2);
  assert.equal(first.skipped, 1);
  assert.deepEqual(first.saved.map(function(f) { return f.filename; }), ['Bank-1.csv', 'Bank-2.csv']);
  assert.equal(fs.readFileSync(path.join(dir, 'Bank-1.csv'), 'utf8'), 'a,b');
  assert.equal(first.path, path.join(dir, 'Bank-1.csv'));

  var again = emailFiles.saveAttachments(dir, all, '7', Object.assign({ ifExists: 'skip' }, input));
  assert.equal(again.count, 0);
  assert.deepEqual(again.existing.map(function(f) { return f.filename; }), ['Bank-1.csv', 'Bank-2.csv']);
  assert.equal(again.path, null);
});
