// s3-upload against a small S3 stand-in on this machine (the connection's
// `endpoint`): one PUT for a small file, CreateMultipartUpload / UploadPart /
// Complete for a large one — each with a SHA-256 checksum, and never a list,
// read or head of the bucket (the key may only write).
var assert = require('node:assert');
var { test } = require('node:test');
var fs = require('fs');
var path = require('path');
var http = require('http');
var { runAction } = require('../../lib/runner');
var upload = require('../../lib/builtins/file/s3-upload');

var root = require('../../lib/dataDir').tenantFolder();
fs.mkdirSync(path.join(root, 'backups'), { recursive: true });

function standIn() {
  var seen = [];
  var server = http.createServer(function(req, res) {
    var body = [];
    req.on('data', function(c) { body.push(c); });
    req.on('end', function() {
      var u = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: u.pathname, query: u.search, headers: req.headers, bytes: Buffer.concat(body).length });
      if (req.method === 'POST' && u.searchParams.has('uploads')) {
        res.setHeader('content-type', 'application/xml');
        return res.end('<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><UploadId>up-1</UploadId></InitiateMultipartUploadResult>');
      }
      if (req.method === 'POST' && u.searchParams.has('uploadId')) {
        res.setHeader('content-type', 'application/xml');
        res.setHeader('x-amz-version-id', 'v-multi');
        return res.end('<?xml version="1.0"?><CompleteMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><ETag>"etag-multi"</ETag></CompleteMultipartUploadResult>');
      }
      if (req.method === 'PUT') {
        res.setHeader('ETag', '"etag-' + seen.length + '"');
        res.setHeader('x-amz-version-id', 'v-1');
        return res.end();
      }
      res.statusCode = 403;
      res.end('<Error><Code>AccessDenied</Code></Error>');
    });
  });
  return new Promise(function(resolve) {
    server.listen(0, '127.0.0.1', function() { resolve({ seen: seen, server: server, url: 'http://127.0.0.1:' + server.address().port }); });
  });
}

function conn(s) {
  return { bucket: 'acme-backups', region: 'ap-south-1', accessKeyId: 'AKIATEST', secretAccessKey: 'secret', prefix: '/backups/', endpoint: s.url, forcePathStyle: true };
}

test('a small file: one PUT to <prefix>/<name>, with a SHA-256 checksum; deleted after when asked', async function() {
  var s = await standIn();
  try {
    var file = path.join(root, 'backups', 'shop.dump');
    fs.writeFileSync(file, 'x'.repeat(1000));
    var res = await runAction(upload, { connection: conn(s), filePath: 'backups/shop.dump', deleteAfter: true });
    assert.equal(res.status, 'success', res.error && res.error.message);
    assert.deepEqual(res.output, { bucket: 'acme-backups', key: 'backups/shop.dump', bytes: 1000, etag: '"etag-1"', versionId: 'v-1', deleted: true });
    assert.equal(s.seen.length, 1);
    assert.equal(s.seen[0].method, 'PUT');
    assert.equal(s.seen[0].path, '/acme-backups/backups/shop.dump');
    var h = s.seen[0].headers;
    assert.ok(h['x-amz-checksum-sha256'] || /sha256/i.test(String(h['x-amz-trailer'] || '') + String(h['x-amz-sdk-checksum-algorithm'] || '')), 'a SHA-256 checksum is sent: ' + JSON.stringify(h));
    assert.ok(!fs.existsSync(file));
  } finally { s.server.close(); }
});

test('a large file: in parts, then completed — still only writes', async function() {
  var s = await standIn();
  try {
    var file = path.join(root, 'backups', 'big.dump');
    fs.writeFileSync(file, Buffer.alloc(17 * 1024 * 1024, 1));
    var res = await runAction(upload, { connection: conn(s), filePath: file, key: 'backups/srv/big.dump' });
    assert.equal(res.status, 'success', res.error && res.error.message);
    assert.deepEqual([res.output.key, res.output.etag, res.output.versionId, res.output.deleted], ['backups/srv/big.dump', '"etag-multi"', 'v-multi', false]);
    var kinds = s.seen.map(function(r) { return r.method + (r.query.indexOf('uploads') !== -1 ? ' create' : r.query.indexOf('partNumber') !== -1 ? ' part' : r.query.indexOf('uploadId') !== -1 ? ' complete' : ''); });
    assert.deepEqual(kinds, ['POST create', 'PUT part', 'PUT part', 'POST complete']);
    assert.ok(s.seen.every(function(r) { return r.method === 'PUT' || r.method === 'POST'; }), 'no GET, HEAD or list');
    assert.ok(fs.existsSync(file), 'kept unless deleteAfter');
  } finally { s.server.close(); }
});

test('refused: no bucket, no region, a file outside the folder or missing', async function() {
  var base = { bucket: 'b', region: 'r', accessKeyId: 'a', secretAccessKey: 's' };
  var cases = [
    [{ connection: { region: 'r' }, filePath: 'x' }, /no bucket/],
    [{ connection: { bucket: 'b' }, filePath: 'x' }, /no region/],
    [{ connection: base, filePath: '/etc/passwd' }, /outside this company's folder/],
    [{ connection: base, filePath: 'backups/none.dump' }, /not a file that exists/]
  ];
  for (var i = 0; i < cases.length; i++) {
    var res = await runAction(upload, cases[i][0]);
    assert.equal(res.status, 'failed');
    assert.match(res.error.message, cases[i][1]);
  }
});

test('the key: as given, else <prefix>/<file name>, never starting with "/"', function() {
  assert.equal(upload._keyFor({}, { prefix: 'backups/srv' }, '/d/a.dump'), 'backups/srv/a.dump');
  assert.equal(upload._keyFor({}, {}, '/d/a.dump'), 'a.dump');
  assert.equal(upload._keyFor({ key: '/x/y.gz' }, { prefix: 'p' }, '/d/a.dump'), 'x/y.gz');
});
