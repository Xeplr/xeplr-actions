// db-dump action — a whole database to one backup file, by the database's own
// dump program: pg_dump (Postgres) or mysqldump (MySQL / MariaDB).
//
//   postgres  pg_dump -Fc --no-owner --no-acl → <db>-<when>.dump (custom
//             format: already compressed, restored with pg_restore)
//   mysql     mysqldump --single-transaction --quick --routines --triggers
//             --events, gzipped here → <db>-<when>.sql.gz
//   mssql     refused: not supported yet
//
// THE PROGRAM IS RUN WITH AN ARGUMENT LIST, never a shell, and only these two
// programs, with arguments built here — nothing from the input reaches the
// command line except the host, port, user and database, each passed as its
// own argument. The password goes in the program's environment (PGPASSWORD,
// MYSQL_PWD), never on the command line, where `ps` would show it.
//
// THE FILE is written under a temporary name and renamed only once the
// program has finished cleanly, so a half-written dump never looks like a
// backup. A failure removes it and fails the step with the end of what the
// program said (stderr), the password taken out. Inside the tenant's own
// folder (lib/dataDir.js), `backups/` unless `folder` says otherwise.
//
// A stop (system.signal) kills the program. system.onProgress({ bytes })
// reports how much is written, every second or so.

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var crypto = require('crypto');
var { spawn } = require('child_process');
var dataDir = require('../../dataDir');

var PROGRAMS = {
  postgres: { bin: 'pg_dump', ext: '.dump', gzip: false, port: 5432 },
  mysql:    { bin: 'mysqldump', ext: '.sql.gz', gzip: true, port: 3306 }
};
var DEFAULT_FOLDER = 'backups';
var STDERR_KEEP = 2048;
var PROGRESS_MS = 1000;

/** "2026-11-13T02-00-05" — a file name's time, UTC. */
function stamp(date) {
  return date.toISOString().slice(0, 19).replace(/:/g, '-');
}

/** A database name made safe for a file name. */
function fileSafe(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'database';
}

/** The program's arguments and environment — the password only in the environment. */
function commandFor(dbType, conn, database) {
  var p = PROGRAMS[dbType];
  var host = String(conn.host || 'localhost');
  var port = String(conn.port || p.port);
  var user = conn.user ? String(conn.user) : null;
  var env = Object.assign({}, process.env);
  if (dbType === 'postgres') {
    var args = ['-Fc', '--no-owner', '--no-acl', '-h', host, '-p', port];
    if (user) args.push('-U', user);
    args.push('-d', database);
    delete env.PGPASSWORD;
    if (conn.password) env.PGPASSWORD = String(conn.password);
    return { bin: p.bin, args: args, env: env };
  }
  var margs = ['--single-transaction', '--quick', '--routines', '--triggers', '--events', '-h', host, '-P', port];
  if (user) margs.push('-u', user);
  margs.push('--databases', database);
  delete env.MYSQL_PWD;
  if (conn.password) env.MYSQL_PWD = String(conn.password);
  return { bin: p.bin, args: margs, env: env };
}

function refuse(message, code) {
  var err = new Error(message);
  err.code = code;
  return err;
}

module.exports = {
  name: 'db-dump',
  // It writes a file, so it is never previewed.
  example: { filePath: '/data/app/backups/shop-2026-11-13T02-00-05.dump', fileName: 'shop-2026-11-13T02-00-05.dump', bytes: 104857600,
    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', dbType: 'postgres', database: 'shop', durationMs: 42000 },
  description: 'Back up a whole database to one file with its own dump program — pg_dump (Postgres, custom format) or mysqldump (MySQL, gzipped). Returns { filePath, fileName, bytes, sha256, dbType, database, durationMs }.',
  requires: [],   // the dump programs are checked when it runs

  inputSchema: [
    { name: 'dbType', type: 'string', required: true, order: 1,
      description: 'postgres or mysql (SQL Server: not supported yet).' },
    { name: 'connection', type: 'object', required: true, order: 2,
      description: '{ host, port, user, password } — the server\'s login, a saved connection (connectionInfoId) resolved by the host.' },
    { name: 'database', type: 'string', required: true, order: 3,
      description: 'The database on that server to back up.' },
    { name: 'folder', type: 'string', order: 4, group: 'File',
      description: 'Where in this company\'s data folder the file goes. Default: backups.' },
    { name: 'fileName', type: 'string', order: 5, group: 'File',
      description: 'The file\'s name. Default: <database>-<UTC time>.dump (Postgres) or .sql.gz (MySQL).' }
  ],
  outputSchema: [
    { name: 'filePath', type: 'string' }, { name: 'fileName', type: 'string' }, { name: 'bytes', type: 'number' },
    { name: 'sha256', type: 'string' }, { name: 'dbType', type: 'string' }, { name: 'database', type: 'string' },
    { name: 'durationMs', type: 'number' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var system = ctx.system || {};
    var dbType = String(input.dbType || '').toLowerCase();
    if (dbType === 'mssql') throw refuse('db-dump: SQL Server is not supported yet — postgres or mysql.', 'DB_TYPE_NOT_SUPPORTED');
    if (!PROGRAMS[dbType]) throw refuse('db-dump: dbType must be postgres or mysql, not "' + input.dbType + '".', 'DB_TYPE_NOT_SUPPORTED');
    var conn = input.connection || {};
    var database = input.database;
    if (!database) throw refuse('db-dump: say which database to back up.', 'NO_DATABASE');
    // An argument starting with "-" would be read as an option, not a name.
    [['database', database], ['host', conn.host], ['user', conn.user]].forEach(function(f) {
      if (f[1] && /^-/.test(String(f[1]))) throw refuse('db-dump: the ' + f[0] + ' "' + f[1] + '" cannot start with "-".', 'BAD_ARGUMENT');
    });

    var started = Date.now();
    var program = PROGRAMS[dbType];
    var folder = dataDir.resolve(input.folder || DEFAULT_FOLDER, 'The backup folder');
    fs.mkdirSync(folder, { recursive: true });
    var name = input.fileName ? String(input.fileName) : fileSafe(database) + '-' + stamp(new Date()) + program.ext;
    var filePath = dataDir.resolve(path.join(folder, name), 'The backup file');
    if (path.dirname(filePath) !== fs.realpathSync(folder)) throw refuse('db-dump: fileName "' + name + '" must be a name, not a path.', 'PATH_NOT_ALLOWED');
    var partial = filePath + '.partial';

    var cmd = commandFor(dbType, conn, String(database));
    var secret = conn.password ? String(conn.password) : null;
    var out = fs.createWriteStream(partial);
    var hash = crypto.createHash('sha256');
    var bytes = 0;
    var stderr = '';
    var child;

    var done = new Promise(function(resolve, reject) {
      var settled = false;
      function fail(err) { if (settled) return; settled = true; reject(err); }
      function ok() { if (settled) return; settled = true; resolve(); }

      try {
        child = spawn(cmd.bin, cmd.args, { env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        fail(e);
        return;
      }
      child.on('error', function(e) {
        fail(e.code === 'ENOENT' ? refuse(cmd.bin + ' is not installed on this server (needed to back up ' + dbType + ').', 'PROGRAM_NOT_FOUND') : e);
      });
      child.stderr.on('data', function(d) { stderr = (stderr + d.toString()).slice(-STDERR_KEEP); });

      var source = program.gzip ? child.stdout.pipe(zlib.createGzip()) : child.stdout;
      source.on('data', function(chunk) { hash.update(chunk); bytes += chunk.length; });
      source.on('error', fail);
      out.on('error', fail);
      source.pipe(out);

      var exit = null;
      var written = false;
      function finish() {
        if (exit === null || !written) return;
        if (exit.code === 0) return ok();
        var said = stderr.trim();
        if (secret) said = said.split(secret).join('****');
        var why = exit.signal ? 'was stopped (' + exit.signal + ')' : 'ended with code ' + exit.code;
        fail(refuse(cmd.bin + ' ' + why + (said ? ': ' + said : ''), 'DUMP_FAILED'));
      }
      child.on('close', function(code, signal) { exit = { code: code, signal: signal }; finish(); });
      out.on('finish', function() { written = true; finish(); });
    });

    var timer = system.onProgress ? setInterval(function() { system.onProgress({ bytes: bytes }); }, PROGRESS_MS) : null;
    var onAbort = function() { if (child && child.exitCode === null) child.kill('SIGTERM'); };
    if (system.signal) {
      if (system.signal.aborted) onAbort();
      else system.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      await done;
    } catch (err) {
      out.destroy();
      try { fs.unlinkSync(partial); } catch (_) {}
      throw err;
    } finally {
      if (timer) clearInterval(timer);
      if (system.signal) system.signal.removeEventListener('abort', onAbort);
    }
    fs.renameSync(partial, filePath);
    if (system.onProgress) system.onProgress({ bytes: bytes });
    return {
      filePath: filePath, fileName: path.basename(filePath), bytes: bytes, sha256: hash.digest('hex'),
      dbType: dbType, database: String(database), durationMs: Date.now() - started
    };
  },

  // For tests: the command a dump runs, without running it.
  _commandFor: commandFor
};
