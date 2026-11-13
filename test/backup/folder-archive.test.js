// folder-archive: a folder of the tenant's own data folder packed with a real
// tar — patterns left out, backups/ and tmp/ never in it, a path outside the
// folder refused, a failure leaving nothing behind.
var assert = require('node:assert');
var { test } = require('node:test');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var { execFileSync } = require('child_process');
var { runAction } = require('../../lib/runner');
var archive = require('../../lib/builtins/file/archive');

var root = fs.realpathSync(require('../../lib/dataDir').tenantFolder());
fs.mkdirSync(path.join(root, 'uploads', 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(root, 'uploads', 'invoice.pdf'), 'pdf');
fs.writeFileSync(path.join(root, 'uploads', 'app.log'), 'log');
fs.writeFileSync(path.join(root, 'uploads', 'node_modules', 'x.js'), 'js');
fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
fs.writeFileSync(path.join(root, 'reports', 'q3.csv'), 'a,b');
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
fs.writeFileSync(path.join(root, 'tmp', 'spool.jsonl'), '{}');
fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
fs.writeFileSync(path.join(root, 'backups', 'old.dump'), 'old');

function entries(file) {
  return execFileSync('tar', ['-tzf', file]).toString().trim().split('\n').filter(function(e) { return !/\/$/.test(e); }).sort();
}

test('a folder: packed, patterns left out, into backups/ as <folder>-<time>.tar.gz with its size and SHA-256', async function() {
  var res = await runAction(archive, { folder: 'uploads', exclude: 'node_modules, *.log' });
  assert.equal(res.status, 'success', res.error && res.error.message);
  var o = res.output;
  assert.match(o.fileName, /^uploads-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.tar\.gz$/);
  assert.equal(path.dirname(o.filePath), path.join(root, 'backups'));
  assert.deepStrictEqual(entries(o.filePath), ['uploads/invoice.pdf']);
  assert.equal(o.bytes, fs.statSync(o.filePath).size);
  assert.equal(o.sha256, crypto.createHash('sha256').update(fs.readFileSync(o.filePath)).digest('hex'));
  assert.deepStrictEqual([o.folder, o.warning], ['uploads', null]);
  assert.ok(!fs.readdirSync(path.join(root, 'backups')).some(function(n) { return /\.partial$/.test(n); }), 'no .partial left');
  fs.unlinkSync(o.filePath);
});

test('the whole folder ("" or "."): every entry but backups/ and tmp/', async function() {
  for (var folder of ['', '.']) {
    var res = await runAction(archive, { folder: folder, fileName: 'all' + (folder ? '-dot' : '') + '.tar.gz' });
    assert.equal(res.status, 'success', res.error && res.error.message);
    var list = entries(res.output.filePath);
    assert.ok(list.indexOf('reports/q3.csv') >= 0 && list.indexOf('uploads/invoice.pdf') >= 0, list.join());
    assert.ok(!list.some(function(e) { return /^(backups|tmp)\//.test(e); }), 'never its own backups or spools: ' + list.join());
    assert.equal(res.output.folder, '.');
    fs.unlinkSync(res.output.filePath);
  }
});

test('refused: outside the folder, ../, backups/ or tmp/ themselves, a pattern that is an option, a path as the name, no such folder', async function() {
  var cases = [
    [{ folder: '/etc' }, /outside this company's folder/],
    [{ folder: '../' }, /outside this company's folder/],
    [{ folder: 'backups' }, /holds the backups and temporary files/],
    [{ folder: 'tmp/x' }, /holds the backups and temporary files|not a folder that exists/],
    [{ folder: 'uploads', exclude: '--to-command=sh' }, /cannot start with "-"/],
    [{ folder: 'uploads', fileName: '../escape.tar.gz' }, /must be a name, not a path|outside this company's folder/],
    [{ folder: 'nope' }, /not a folder that exists/]
  ];
  for (var c of cases) {
    var res = await runAction(archive, c[0]);
    assert.equal(res.status, 'failed', JSON.stringify(c[0]));
    assert.match(res.error.message, c[1], JSON.stringify(c[0]));
  }
});

test('a link pointing out of the folder is refused like any other path', async function() {
  var outside = fs.mkdtempSync(path.join(require('os').tmpdir(), 'outside-'));
  fs.symlinkSync(outside, path.join(root, 'sneaky'));
  var res = await runAction(archive, { folder: 'sneaky' });
  assert.equal(res.status, 'failed');
  assert.match(res.error.message, /outside this company's folder/);
  fs.unlinkSync(path.join(root, 'sneaky'));
});
