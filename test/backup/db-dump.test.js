// db-dump: the dump program run with an argument list and the password only
// in its environment, the file written under a temporary name and renamed
// once the program ends cleanly, a failure leaving nothing behind. A fake
// pg_dump / mysqldump on PATH says what it was given; then, when a real
// Postgres and pg_dump are here, a real dump restored with pg_restore --list.
var assert = require('node:assert');
var { test } = require('node:test');
var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var crypto = require('crypto');
var { execFileSync } = require('child_process');
var { runAction } = require('../../lib/runner');
var dump = require('../../lib/builtins/db/dump');

var root = require('../../lib/dataDir').tenantFolder();
var bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-dump-'));
// Prints its arguments and the password it found in its environment; exits with $FAKE_EXIT.
var script = '#!/bin/sh\necho "args: $*"\necho "pw: ${PGPASSWORD:-}${MYSQL_PWD:-}"\necho "said on stderr: secret-pw broke" >&2\nexit ${FAKE_EXIT:-0}\n';
['pg_dump', 'mysqldump'].forEach(function(b) { fs.writeFileSync(path.join(bin, b), script, { mode: 0o755 }); });

function withFake(fn) {
  return async function() {
    var was = process.env.PATH;
    process.env.PATH = bin + path.delimiter + was;
    try { await fn(); } finally { process.env.PATH = was; delete process.env.FAKE_EXIT; }
  };
}

var CONN = { host: 'db.internal', port: 5433, user: 'backup', password: 'secret-pw' };

test('postgres: pg_dump -Fc with the login as arguments, the password only in its environment', withFake(async function() {
  var res = await runAction(dump, { dbType: 'postgres', connection: CONN, database: 'shop' });
  assert.equal(res.status, 'success', res.error && res.error.message);
  var o = res.output;
  assert.match(o.fileName, /^shop-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.dump$/);
  assert.equal(path.dirname(o.filePath), fs.realpathSync(path.join(root, 'backups')), 'in the tenant\'s backups/ by default');
  var text = fs.readFileSync(o.filePath, 'utf8');
  assert.match(text, /^args: -Fc --no-owner --no-acl -h db\.internal -p 5433 -U backup -d shop$/m);
  assert.match(text, /^pw: secret-pw$/m, 'PGPASSWORD set');
  assert.ok(!/secret-pw/.test(text.split('\n')[0]), 'never an argument');
  assert.equal(o.bytes, fs.statSync(o.filePath).size);
  assert.equal(o.sha256, crypto.createHash('sha256').update(fs.readFileSync(o.filePath)).digest('hex'));
  assert.deepEqual([o.dbType, o.database], ['postgres', 'shop']);
  assert.ok(!fs.existsSync(o.filePath + '.partial'));
}));

test('mysql: mysqldump in one transaction, gzipped here, MYSQL_PWD in its environment', withFake(async function() {
  var res = await runAction(dump, { dbType: 'mysql', connection: { host: 'm', user: 'u', password: 'secret-pw' }, database: 'crm', folder: 'nightly', fileName: 'crm.sql.gz' });
  assert.equal(res.status, 'success', res.error && res.error.message);
  assert.equal(res.output.filePath, path.join(fs.realpathSync(root), 'nightly', 'crm.sql.gz'));
  var text = zlib.gunzipSync(fs.readFileSync(res.output.filePath)).toString();
  assert.match(text, /^args: --single-transaction --quick --routines --triggers --events -h m -P 3306 -u u --databases crm$/m);
  assert.match(text, /^pw: secret-pw$/m);
}));

test('a failing dump: no file left, the program\'s words with the password taken out', withFake(async function() {
  process.env.FAKE_EXIT = '2';
  var res = await runAction(dump, { dbType: 'postgres', connection: CONN, database: 'broken', fileName: 'broken.dump' });
  assert.equal(res.status, 'failed');
  assert.match(res.error.message, /pg_dump ended with code 2: said on stderr: \*\*\*\* broke/);
  assert.ok(!/secret-pw/.test(res.error.message));
  assert.ok(!fs.existsSync(path.join(root, 'backups', 'broken.dump')) && !fs.existsSync(path.join(root, 'backups', 'broken.dump.partial')));
}));

test('refused: SQL Server, an unknown type, no database, a name read as an option, a file outside the folder', async function() {
  var cases = [
    [{ dbType: 'mssql', connection: CONN, database: 'x' }, /SQL Server is not supported yet/],
    [{ dbType: 'oracle', connection: CONN, database: 'x' }, /postgres or mysql/],
    [{ dbType: 'postgres', connection: CONN }, /database/],
    [{ dbType: 'mysql', connection: CONN, database: '--all-databases' }, /cannot start with "-"/],
    [{ dbType: 'postgres', connection: CONN, database: 'x', folder: '../../etc' }, /outside this company's folder/],
    [{ dbType: 'postgres', connection: CONN, database: 'x', fileName: '../escape.dump' }, /must be a name|outside/]
  ];
  for (var i = 0; i < cases.length; i++) {
    var res = await runAction(dump, cases[i][0]);
    assert.equal(res.status, 'failed', JSON.stringify(cases[i][0]));
    assert.match(res.error.message, cases[i][1]);
  }
});

test('a dump program that is not installed is named', async function() {
  var was = process.env.PATH;
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
  try {
    var res = await runAction(dump, { dbType: 'mysql', connection: CONN, database: 'x' });
    assert.match(res.error.message, /mysqldump is not installed on this server/);
  } finally { process.env.PATH = was; }
});

test('a real Postgres: pg_dump writes a dump pg_restore can read', async function(t) {
  var PG = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || process.env.USER, password: process.env.PGPASSWORD };
  try { execFileSync('pg_restore', ['--version']); } catch (_) { t.skip('no pg_restore here'); return; }
  var pg = require('../../lib/drivers/db/postgres');
  var admin;
  try { admin = await pg.connect(Object.assign({ database: 'postgres' }, PG)); await admin.query('SELECT 1'); } catch (err) { t.skip('no Postgres available (' + err.message + ')'); return; }
  var table = 'dump_check_' + process.pid;
  try {
    await admin.query('CREATE TABLE ' + table + ' (id int)');
    var res = await runAction(dump, { dbType: 'postgres', connection: PG, database: 'postgres', fileName: 'real.dump' });
    if (res.error && /server version mismatch|pg_dump version/.test(res.error.message)) { t.skip('pg_dump here is older than the server: ' + res.error.message); return; }
    assert.equal(res.status, 'success', res.error && res.error.message);
    var listing = execFileSync('pg_restore', ['--list', res.output.filePath]).toString();
    assert.match(listing, new RegExp('TABLE public ' + table));
  } finally {
    await admin.query('DROP TABLE IF EXISTS ' + table);
    await pg.close(admin);
  }
});
