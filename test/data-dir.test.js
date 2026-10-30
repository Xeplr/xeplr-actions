// @flags: --require=./test/setup-data-dir.cjs
// Each tenant's files are in its own folder under XEPLR_DATA_DIR, and no step
// reaches another's: two companies, the same names, on a real folder.
// Tenancy registered as BI registers it (company, workspace).
var assert = require('node:assert');
var { test } = require('node:test');
var fs = require('fs');
var path = require('path');
var { registerMTs, runWithMt } = require('@xeplr/db');
var { runAction } = require('../lib/runner');
var dataDir = require('../lib/dataDir');
var list = require('../lib/builtins/file/list');
var read = require('../lib/builtins/file/read');
var move = require('../lib/builtins/file/move');
var sendEmail = require('../lib/builtins/send-email');
var dbPush = require('../lib/builtins/db/push');
var upload = require('../lib/builtins/file/upload');

registerMTs({ l1: { name: 'companyId', header: 'x-company-id' }, l2: { name: 'workspaceId', header: 'x-workspace-id' } });
var ROOT = fs.realpathSync(process.env.XEPLR_DATA_DIR);
var ACME = { mtId1: 'acme', mtId2: 'ws1' };
var BETA = { mtId1: 'beta', mtId2: 'ws1' };
var as = function(mt, fn) { return runWithMt(mt, fn); };

test('a tenant\'s folder is <root>/<app>/<company>/<workspace>, made on first use', async function() {
  var acme = await as(ACME, function() { return dataDir.tenantFolder(); });
  assert.equal(acme, path.join(ROOT, 'xeplr-actions-test', 'acme', 'ws1'));
  assert.ok(fs.statSync(acme).isDirectory());
  var tmp = await as(ACME, function() { return dataDir.scratch(); });
  assert.equal(tmp, path.join(acme, 'tmp'));
});

test('the same name is each company\'s own file', async function() {
  await as(ACME, function() { fs.mkdirSync(path.join(dataDir.tenantFolder(), 'bank'), { recursive: true }); fs.writeFileSync(path.join(dataDir.tenantFolder(), 'bank', 'sept.csv'), 'who\nacme\n'); });
  await as(BETA, function() { fs.mkdirSync(path.join(dataDir.tenantFolder(), 'bank'), { recursive: true }); fs.writeFileSync(path.join(dataDir.tenantFolder(), 'bank', 'sept.csv'), 'who\nbeta\n'); });
  var a = await as(ACME, function() { return runAction(read, { path: 'bank/sept.csv' }); });
  var b = await as(BETA, function() { return runAction(read, { path: 'bank/sept.csv' }); });
  assert.equal(a.output.rows[0].who, 'acme');
  assert.equal(b.output.rows[0].who, 'beta');
});

test('one company never reaches another\'s: not by full path, ../, a link, or a move', async function() {
  var acmeFile = path.join(ROOT, 'xeplr-actions-test', 'acme', 'ws1', 'bank', 'sept.csv');
  var full = await as(BETA, function() { return runAction(read, { path: acmeFile }); });
  assert.equal(full.error.code, 'PATH_NOT_ALLOWED');
  var climb = await as(BETA, function() { return runAction(read, { path: '../../acme/ws1/bank/sept.csv' }); });
  assert.equal(climb.error.code, 'PATH_NOT_ALLOWED');
  var otherWs = await as(BETA, function() { return runAction(list, { folder: '../ws2' }); });
  assert.equal(otherWs.error.code, 'PATH_NOT_ALLOWED');
  await as(BETA, function() { fs.symlinkSync(path.join(ROOT, 'xeplr-actions-test', 'acme'), path.join(dataDir.tenantFolder(), 'acme-link')); });
  var linked = await as(BETA, function() { return runAction(read, { path: 'acme-link/ws1/bank/sept.csv' }); });
  assert.equal(linked.error.code, 'PATH_NOT_ALLOWED');
  var stolen = await as(BETA, function() { return runAction(move, { from: acmeFile, to: 'bank/' }); });
  assert.equal(stolen.error.code, 'PATH_NOT_ALLOWED');
  var dropped = await as(ACME, function() { return runAction(move, { from: 'bank/sept.csv', to: path.join(ROOT, 'xeplr-actions-test', 'beta', 'ws1') + '/' }); });
  assert.equal(dropped.error.code, 'PATH_NOT_ALLOWED');
  assert.ok(fs.existsSync(acmeFile), 'nothing moved');
});

test('a job for every company (*) has a folder of its own, _all; no tenant has none', async function() {
  var all = await as({ mtId1: '*', mtId2: '*' }, function() { return dataDir.tenantFolder(); });
  assert.equal(all, path.join(ROOT, 'xeplr-actions-test', '_all', '_all'));
  var companyWide = await as({ mtId1: 'acme', mtId2: '*' }, function() { return dataDir.tenantFolder(); });
  assert.equal(companyWide, path.join(ROOT, 'xeplr-actions-test', 'acme', '_all'));
  var none = await runAction(list, { folder: 'bank' });
  assert.equal(none.error.code, 'NO_TENANT');
  var half = await as({ mtId1: 'acme' }, function() { return runAction(list, { folder: 'bank' }); });
  assert.equal(half.error.code, 'NO_TENANT');
  var sneaky = await as({ mtId1: '..', mtId2: 'ws1' }, function() { return runAction(list, { folder: 'bank' }); });
  assert.equal(sneaky.error.code, 'NO_TENANT');
  var slash = await as({ mtId1: 'a/b', mtId2: 'ws1' }, function() { return runAction(list, { folder: 'bank' }); });
  assert.equal(slash.error.code, 'NO_TENANT');
});

test('email: attachments only from the company\'s folder, never an address; the body is text', async function() {
  var input = { emailType: 'system', to: ['x@example.com'], subject: 's', html: 'h' };
  var outside = await as(ACME, function() { return runAction(sendEmail, Object.assign({}, input, { attachments: [{ filename: 'env', path: '/etc/hosts' }] })); });
  assert.equal(outside.error.code, 'PATH_NOT_ALLOWED');
  var url = await as(ACME, function() { return runAction(sendEmail, Object.assign({}, input, { attachments: [{ filename: 'x', path: 'http://169.254.169.254/latest' }] })); });
  assert.equal(url.error.code, 'PATH_NOT_ALLOWED');
  var href = await as(ACME, function() { return runAction(sendEmail, Object.assign({}, input, { attachments: [{ filename: 'x', href: 'http://internal/' }] })); });
  assert.equal(href.error.code, 'PATH_NOT_ALLOWED');
  // A body given as { path } (which the mail library would read from disk) is
  // refused by the step's own schema, and again by the step itself.
  var body = await as(ACME, function() { return runAction(sendEmail, Object.assign({}, input, { html: { path: '/etc/hosts' } })); });
  assert.equal(body.status, 'failed');
  assert.match(body.error.message, /expected type string|must be text/);
  var direct = await as(ACME, function() { return sendEmail.execute({ input: Object.assign({}, input, { text: { path: '/etc/hosts' } }) }); }).then(function() { return null; }, function(e) { return e; });
  assert.match(direct.message, /must be text/);
  var neither = await as(ACME, function() { return runAction(sendEmail, Object.assign({}, input, { attachments: [{ filename: 'x' }] })); });
  assert.match(neither.error.message, /neither a path nor content/);
});

test('db-push and a local upload read only from the company\'s folder', async function() {
  var acmeFile = path.join(ROOT, 'xeplr-actions-test', 'acme', 'ws1', 'bank', 'sept.csv');
  var push = await as(BETA, function() { return runAction(dbPush, { dbType: 'postgres', connection: { host: 'x' }, targetTable: 't', filePath: acmeFile }); });
  assert.equal(push.status, 'failed');
  assert.match(push.error.message, /outside this company's folder/);
  var up = await as(BETA, function() {
    return runAction(upload, { sourceType: 'local', sourcePath: '/etc/hosts', format: 'csv', dbType: 'postgres', dbConnection: { host: 'x' }, targetTable: 't' });
  });
  assert.equal(up.status, 'failed');
  assert.match(up.error.message, /outside this company's folder/);
});
