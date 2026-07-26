#!/usr/bin/env node
/*
 * CLI to upload a file (CSV or Excel) to Postgres via @xeplr/actions.
 *
 * Three ways to supply the DB connection (in order of preference):
 *
 *   1) Encrypted named connection (matches xeplr-db)
 *        export ENCRYPTION_KEY='your-passphrase'
 *        export PG_PROD_CONNECTION='<encrypted-JSON-blob>'
 *        node scripts/upload-file.js --file data.xlsx --table t --conn-name pg-prod
 *
 *   2) Inline encrypted blob (great for CI — one secret)
 *        export ENCRYPTION_KEY='your-passphrase'
 *        node scripts/upload-file.js --file data.xlsx --table t --conn '<blob>'
 *
 *   3) Individual flags / PG* env vars (escape hatch)
 *        node scripts/upload-file.js --file data.xlsx --table t \
 *          --host localhost --port 5435 --db mydb --user postgres --password 'pw'
 *
 * Generate an encrypted blob:
 *        node scripts/upload-file.js --encrypt-conn --key 'your-passphrase' \
 *          --host localhost --port 5435 --db mydb --user postgres --password 'pw'
 */

var path = require('path');
var fs = require('fs');
var actions = require('..');                             // @xeplr/actions main
var fileUpload = require('../lib/builtins/file/upload'); // the action module

function parseArgs(argv) {
  var out = {};
  for (var i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      var key = argv[i].slice(2);
      var val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) { out[key] = true; }
      else                                            { out[key] = val; i++; }
    }
  }
  return out;
}

function usage() {
  console.error('');
  console.error('Usage: node scripts/upload-file.js --file <path> --table <name> [connection] [options]');
  console.error('');
  console.error('Required:');
  console.error('  --file        Path to CSV or XLSX file');
  console.error('  --table       Target table name');
  console.error('');
  console.error('Connection (pick ONE):');
  console.error('  --conn-name   Named encrypted connection. Reads <NAME>_CONNECTION env var,');
  console.error('                decrypts with $ENCRYPTION_KEY. Same pattern as xeplr-db.');
  console.error('  --conn        Inline encrypted blob. Decrypted with $ENCRYPTION_KEY.');
  console.error('  --host/--port/--user/--password/--db  (or PGHOST/PGPORT/…) — plain flags.');
  console.error('');
  console.error('Options:');
  console.error('  --pk          Primary key column(s), comma-separated (enables UPSERT)');
  console.error('  --format      csv | excel (default: from file extension)');
  console.error('  --sheet       Excel sheet name (default: first sheet)');
  console.error('  --batchSize   Rows per INSERT batch (default 5000)');
  console.error('  --movementId  Movement id (default: auto)');
  console.error('  --dry         Print resolved input and exit — do not touch DB');
  console.error('');
  console.error('Utilities:');
  console.error('  --encrypt-conn  Print an encrypted blob for the given --host/--port/--user/');
  console.error('                  --password/--db. Requires --key (or $ENCRYPTION_KEY).');
  console.error('');
}

function detectFormat(filePath) {
  var ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv')                                return 'csv';
  if (ext === '.xlsx' || ext === '.xls')             return 'excel';
  return null;
}

// Resolve the DB connection object using — in priority order:
//   1) --conn-name  → decrypt $<NAME>_CONNECTION with $ENCRYPTION_KEY
//   2) --conn       → decrypt the inline blob with $ENCRYPTION_KEY
//   3) individual --host/--port/... (or PG* env vars)
//
// Returns { host, port, user, password, database } — throws with a clear
// message on any missing piece. Never returns a partial connection.
async function resolveConnection(args) {
  var { decrypt } = require('@xeplr/utils/isomorphic/crypto');

  function requireKey(reason) {
    var k = process.env.ENCRYPTION_KEY;
    if (!k) throw new Error('ENCRYPTION_KEY env var is required to ' + reason + '.');
    return k;
  }

  async function fromBlob(blob, source) {
    var key = requireKey('decrypt ' + source);
    var decrypted = await decrypt(blob, key);
    var cfg;
    try { cfg = JSON.parse(decrypted); }
    catch (_) { throw new Error(source + ' decrypted successfully but did not contain valid JSON.'); }

    // ArchFlow / xeplr-db convention: the blob is per-SERVER (host/port/user/
    // password only) — the database name is supplied separately, so one blob
    // can serve architects_api, architects_auth, etc. Accept both blob shapes:
    // with or without database.
    ['host', 'port', 'user'].forEach(function(k) {
      if (cfg[k] == null || cfg[k] === '') throw new Error(source + ' missing field: ' + k);
    });
    if (cfg.password == null) {
      throw new Error(source + " missing field: password (use '' explicitly for passwordless)");
    }
    cfg.port = parseInt(cfg.port, 10);

    // If the blob didn't carry a database, take one from the flag / env.
    if (!cfg.database) {
      cfg.database = args.db || process.env.PGDATABASE;
      if (!cfg.database) {
        throw new Error(source + ' has no database field, and --db (or $PGDATABASE) was not provided. ' +
          'The encrypted blob is per-server; you must name the target database separately.');
      }
    }
    return cfg;
  }

  if (args['conn-name']) {
    var envKey = String(args['conn-name']).toUpperCase().replace(/-/g, '_') + '_CONNECTION';
    var enc = process.env[envKey];
    if (!enc) throw new Error(envKey + ' env var is required for --conn-name ' + args['conn-name']);
    return await fromBlob(enc, envKey);
  }

  if (args.conn) {
    return await fromBlob(args.conn, '--conn');
  }

  var connection = {
    host:     args.host     || process.env.PGHOST,
    port:     args.port     ? parseInt(args.port, 10)
                            : (process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : null),
    user:     args.user     || process.env.PGUSER,
    password: args.password != null ? args.password : process.env.PGPASSWORD,
    database: args.db       || process.env.PGDATABASE
  };
  var missing = [];
  if (!connection.host)              missing.push('--host       (or $PGHOST)');
  if (!connection.port)              missing.push('--port       (or $PGPORT)');
  if (!connection.user)              missing.push('--user       (or $PGUSER)');
  if (connection.password == null)   missing.push('--password   (or $PGPASSWORD)');
  if (!connection.database)          missing.push('--db         (or $PGDATABASE)');
  if (missing.length) {
    var err = new Error('missing-connection');
    err.missing = missing;
    throw err;
  }
  return connection;
}

// --encrypt-conn utility: read host/port/... from flags, emit an encrypted
// blob suitable for --conn or $<NAME>_CONNECTION. Never prints the plaintext.
async function encryptConnCommand(args) {
  var { encrypt } = require('@xeplr/utils/isomorphic/crypto');
  var key = args.key || process.env.ENCRYPTION_KEY;
  if (!key) { console.error('--encrypt-conn requires --key (or $ENCRYPTION_KEY)'); process.exit(1); }

  var cfg = {
    host:     args.host,
    port:     args.port ? parseInt(args.port, 10) : null,
    user:     args.user,
    password: args.password != null ? args.password : '',
    database: args.db
  };
  var missing = ['host','port','user','database'].filter(function(k) { return !cfg[k]; });
  if (missing.length) {
    console.error('--encrypt-conn requires: --host --port --user --password --db  (missing: ' + missing.join(', ') + ')');
    process.exit(1);
  }
  var blob = await encrypt(JSON.stringify(cfg), key);
  console.log(blob);
}

async function main() {
  var args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { usage(); process.exit(0); }

  if (args['encrypt-conn']) { await encryptConnCommand(args); return; }

  if (!args.file || !args.table) { usage(); process.exit(1); }
  if (!fs.existsSync(args.file)) { console.error('File not found: ' + args.file); process.exit(1); }

  var format = args.format || detectFormat(args.file);
  if (!format)  { console.error('Cannot detect format from ' + args.file + '. Pass --format csv|excel.'); process.exit(1); }
  if (!['csv','excel'].includes(format)) {
    console.error('Unsupported --format: ' + format + ' (supported: csv, excel)');
    process.exit(1);
  }

  var connection;
  try {
    connection = await resolveConnection(args);
  } catch (e) {
    console.error('');
    if (e.missing) {
      console.error('Missing required connection param(s):');
      e.missing.forEach(function(m) { console.error('  ' + m); });
      console.error('');
      console.error('Or use an encrypted connection: --conn-name <name>  |  --conn <blob>');
    } else {
      console.error('Connection error: ' + e.message);
    }
    console.error('');
    console.error('Refusing to run — landing rows on the wrong DB is not a defensible default.');
    process.exit(1);
  }

  var input = {
    sourceType:  'local',
    sourcePath:  path.resolve(args.file),
    format:      format,
    formatConfig: format === 'excel' && args.sheet ? { sheet: args.sheet } : {},
    dbType:      'postgres',
    dbConnection: connection,
    targetTable: args.table,
    primaryKeys: args.pk ? String(args.pk).split(',').map(function(s){return s.trim();}) : undefined,
    batchSize:   args.batchSize ? parseInt(args.batchSize, 10) : undefined,
    movementId:  args.movementId || undefined
  };

  console.log('─── Upload ─────────────────────────────────');
  console.log('  file   :', input.sourcePath);
  console.log('  format :', input.format + (input.formatConfig.sheet ? ' (sheet=' + input.formatConfig.sheet + ')' : ''));
  console.log('  target :', connection.host + ':' + connection.port + '/' + connection.database + ' → ' + input.targetTable);
  console.log('  PK     :', input.primaryKeys ? input.primaryKeys.join(',') + ' (UPSERT)' : '(none — plain INSERT)');
  console.log('────────────────────────────────────────────');

  if (args.dry) { console.log('\n[dry] not executing. Input:', input); return; }

  var start = Date.now();
  var result = await actions.runAction(fileUpload, input);
  var ms = Date.now() - start;

  console.log('');
  console.log('Status       :', result.status);
  console.log('Duration     :', ms + 'ms');

  if (result.status === 'success') {
    var o = result.output;
    console.log('Total rows       :', o.totalRows);
    console.log('Batches total    :', o.totalBatches);
    console.log('Batches OK       :', o.completed);
    console.log('Batches dropped  :', o.dropped);
    console.log('Movement id      :', o.movementId);
    console.log('Main table       :', o.tables.main);
    console.log('Error table      :', o.tables.errors);
    if (o.dropped > 0) {
      console.log('');
      console.log('  ⚠ ' + o.dropped + ' batch(es) had failures — check ' + o.tables.errors +
                  ' for details (SELECT * FROM ' + o.tables.errors + ' WHERE movement_id = \'' + o.movementId + '\')');
    }
    console.log('');
    console.log('Columns          :');
    o.columns.forEach(function(c) {
      var line = '  ' + c.name.padEnd(28) + c.type;
      if (c.sourceType && c.sourceType !== c.type) line += '  (source: ' + c.sourceType + ' → target: ' + c.type + ')';
      console.log(line);
    });
    console.log('');
    console.log('To rollback:');
    console.log('  DELETE FROM ' + o.tables.main +
                ' WHERE __xeplr_movement_id__ = \'' + o.movementId + '\';');
  } else {
    console.error('Error name   :', result.error && result.error.name);
    console.error('Error message:', result.error && result.error.message);
    if (result.error && result.error.details) {
      console.error('Details      :', result.error.details);
    }
    process.exit(2);
  }
}

main().catch(function(err) {
  console.error('Fatal:', err && err.message ? err.message : err);
  console.error(err && err.stack);
  process.exit(1);
});
