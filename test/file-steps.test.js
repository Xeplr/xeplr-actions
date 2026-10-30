// file-list, file-read, file-move and file-delete, on a real folder: they work
// inside the tenant's own folder under XEPLR_DATA_DIR, and nowhere else. This
// process registers no tenancy, so its folder is <root>/<app>
// (test/setup-data-dir.cjs); tenants are test/data-dir.test.js.
var assert = require('node:assert');
var { test } = require('node:test');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { runAction } = require('../lib/runner');
var list = require('../lib/builtins/file/list');
var read = require('../lib/builtins/file/read');
var move = require('../lib/builtins/file/move');
var del = require('../lib/builtins/file/delete');

var root = require('../lib/dataDir').tenantFolder();
var outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xeplr-outside-')));
fs.mkdirSync(path.join(root, 'bank'));
fs.writeFileSync(path.join(root, 'bank', 'Bank-2026-09.csv'), 'ref,amount,date\nA1,500,2026-09-02\nA2,20,2026-09-03\n');
fs.writeFileSync(path.join(root, 'bank', 'Bank-2026-08.csv'), 'ref,amount\nB1,1\n');
fs.writeFileSync(path.join(root, 'bank', 'notes.txt'), 'x');
fs.writeFileSync(path.join(root, 'bank', 'rows.ndjson'), '{"a":1}\n{"a":2}\n\n{"a":3}\n');
fs.writeFileSync(path.join(outside, 'secret.csv'), 'a\n1\n');

test('list: the files in a folder, matching a pattern', async function() {
  var res = await runAction(list, { folder: path.join(root, 'bank'), pattern: 'Bank-2026-??.csv' });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.deepEqual(res.output.files.map(function(f) { return f.name; }), ['Bank-2026-08.csv', 'Bank-2026-09.csv']);
  assert.equal(res.output.count, 2);
  assert.ok(res.output.files[0].size > 0 && res.output.files[0].modifiedAt);
});

test('list: "is it there?" is an exact name and a count', async function() {
  var there = await runAction(list, { folder: path.join(root, 'bank'), pattern: 'Bank-2026-10.csv' });
  assert.equal(there.output.count, 0);
});

test('read: a CSV as rows, with its columns in order', async function() {
  var res = await runAction(read, { path: path.join(root, 'bank', 'Bank-2026-09.csv') });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.equal(res.output.count, 2);
  assert.equal(res.output.rows[0].ref, 'A1');
  assert.deepEqual(res.output.columns.map(function(c) { return c.key; }), ['ref', 'amount', 'date']);
  assert.equal(res.output.truncated, false);
});

test('read: NDJSON, and a limit says it stopped', async function() {
  var res = await runAction(read, { path: path.join(root, 'bank', 'rows.ndjson'), maxRows: 2 });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.deepEqual(res.output.rows, [{ a: 1 }, { a: 2 }]);
  assert.equal(res.output.truncated, true);
});

test('read: a file that is not there, or an extension it cannot read, is refused by name', async function() {
  var gone = await runAction(read, { path: path.join(root, 'bank', 'nope.csv') });
  assert.equal(gone.error.code, 'FILE_NOT_FOUND');
  fs.writeFileSync(path.join(root, 'bank', 'x.bin'), 'x');
  var odd = await runAction(read, { path: path.join(root, 'bank', 'x.bin') });
  assert.equal(odd.error.code, 'FORMAT_UNKNOWN');
});

test('nothing outside the tenant\'s folder: not by path, not by ../, not by a link, not an address', async function() {
  var direct = await runAction(read, { path: path.join(outside, 'secret.csv') });
  assert.equal(direct.error.code, 'PATH_NOT_ALLOWED');
  assert.match(direct.error.message, /outside this company's folder/);
  var climb = await runAction(read, { path: path.join(root, 'bank', '..', '..', path.basename(outside), 'secret.csv') });
  assert.equal(climb.error.code, 'PATH_NOT_ALLOWED');
  fs.symlinkSync(outside, path.join(root, 'link'));
  var linked = await runAction(read, { path: path.join(root, 'link', 'secret.csv') });
  assert.equal(linked.error.code, 'PATH_NOT_ALLOWED');
  var named = await runAction(read, { path: '../../' + path.basename(outside) + '/secret.csv' });
  assert.equal(named.error.code, 'PATH_NOT_ALLOWED');
  var address = await runAction(read, { path: 'file:///etc/passwd' });
  assert.equal(address.error.code, 'PATH_NOT_ALLOWED');
});

test('a name is inside the tenant\'s folder: bank is <folder>/bank', async function() {
  var res = await runAction(list, { folder: 'bank', pattern: '*.csv' });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.ok(res.output.files.every(function(f) { return f.path.indexOf(path.join(root, 'bank') + path.sep) === 0; }));
  var read1 = await runAction(read, { path: 'bank/Bank-2026-09.csv' });
  assert.equal(read1.output.count, 2);
});

test('no data root: refused, naming the setting', async function() {
  var saved = process.env.XEPLR_DATA_DIR;
  try {
    delete process.env.XEPLR_DATA_DIR;
    var unset = await runAction(list, { folder: 'bank' });
    assert.equal(unset.error.code, 'DATA_DIR_UNSET');
    assert.match(unset.error.message, /XEPLR_DATA_DIR is not set/);
    process.env.XEPLR_DATA_DIR = 'data';
    assert.match((await runAction(list, { folder: 'bank' })).error.message, /must be an absolute folder/);
    process.env.XEPLR_DATA_DIR = path.join(outside, 'not-there');
    assert.match((await runAction(list, { folder: 'bank' })).error.message, /not a folder that exists/);
  } finally {
    process.env.XEPLR_DATA_DIR = saved;
  }
});

test('move: into a folder made on the way, keeping its name; again is refused; copy leaves the original', async function() {
  var archive = path.join(root, 'archive', '2026-09') + '/';
  var src = path.join(root, 'bank', 'Bank-2026-08.csv');
  var res = await runAction(move, { from: src, to: archive });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.equal(res.output.name, 'Bank-2026-08.csv');
  assert.ok(!fs.existsSync(src) && fs.existsSync(path.join(archive, 'Bank-2026-08.csv')));

  fs.writeFileSync(src, 'again');
  var again = await runAction(move, { from: src, to: archive });
  assert.equal(again.error.code, 'FILE_EXISTS');
  assert.ok(fs.existsSync(src), 'nothing moved');

  var copied = await runAction(move, { from: src, to: archive, operation: 'copy', ifExists: 'addSuffix' });
  assert.equal(copied.output.name, 'Bank-2026-08 (2).csv');
  assert.ok(fs.existsSync(src));
});

test('move: to a new name, and never out of the tenant\'s folder', async function() {
  var src = path.join(root, 'bank', 'notes.txt');
  var res = await runAction(move, { from: src, to: path.join(root, 'bank', 'Notes Sep 2026.txt') });
  assert.equal(res.output.name, 'Notes Sep 2026.txt');
  var out = await runAction(move, { from: path.join(root, 'bank', 'Notes Sep 2026.txt'), to: outside + '/' });
  assert.equal(out.error.code, 'PATH_NOT_ALLOWED');
});

test('delete: one file, gone; a missing one fails or is skipped; never a folder or outside', async function() {
  var file = path.join(root, 'bank', 'done.csv');
  fs.writeFileSync(file, 'a\n1\n');
  var res = await runAction(del, { path: file });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.deepEqual(res.output, { path: file, deleted: true, skipped: false });
  assert.ok(!fs.existsSync(file));

  var again = await runAction(del, { path: file });
  assert.equal(again.error.code, 'FILE_NOT_FOUND');
  var skipped = await runAction(del, { path: file, ifMissing: 'skip' });
  assert.equal(skipped.status, 'success');
  assert.equal(skipped.output.skipped, true);
  assert.equal(skipped.output.deleted, false);

  var folder = await runAction(del, { path: path.join(root, 'bank') });
  assert.equal(folder.error.code, 'NOT_A_FILE');
  assert.ok(fs.existsSync(path.join(root, 'bank')));

  var out = await runAction(del, { path: path.join(outside, 'secret.csv') });
  assert.equal(out.error.code, 'PATH_NOT_ALLOWED');
  assert.ok(fs.existsSync(path.join(outside, 'secret.csv')), 'nothing outside is touched');
});
