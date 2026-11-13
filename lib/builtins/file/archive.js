// folder-archive action — a folder of this company's data folder, packed into
// one .tar.gz backup file (then s3-upload sends it away).
//
//   folder    inside the tenant's own folder (lib/dataDir.js), checked like
//             every file step's: a path outside, ../ or a link pointing out is
//             refused. '' or '.' is the whole tenant folder
//   never     the tenant's own backups/ and tmp/ — a backup must not hold the
//             backups before it, nor half-written spools. Archiving the whole
//             folder names every other entry; naming backups/ or tmp/ (or a
//             folder inside them) is refused
//   exclude   patterns left out ("node_modules, *.log"), tar's --exclude; none
//             may start with "-", which tar would read as an option
//
// `tar -czf` is RUN WITH AN ARGUMENT LIST, never a shell. The file is written
// as <name>.partial and renamed only once tar ends: exit 0, or 1 — GNU tar's
// "a file changed while it was read" (a log being written), where the archive
// is whole — which comes back as `warning`. Anything else removes the file and
// fails the step with the end of what tar said. A stop (system.signal) kills
// tar. Written to the tenant's backups/: <slug>-<UTC time>.tar.gz.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var { spawn } = require('child_process');
var dataDir = require('../../dataDir');

var OUT_FOLDER = 'backups';
var NEVER = ['backups', 'tmp'];
var STDERR_KEEP = 2048;

function refuse(message, code) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function stamp(date) {
  return date.toISOString().slice(0, 19).replace(/:/g, '-');
}

/** "uploads/2026" → "uploads-2026"; the whole folder → "all". */
function slugOf(rel) {
  return String(rel).replace(/^[./]+|\/+$/g, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'all';
}

/** "node_modules, *.log" → the patterns; one starting with "-" is refused. */
function excludesOf(text) {
  var list = (Array.isArray(text) ? text : String(text || '').split(/[\n,]/)).map(function(p) { return String(p).trim(); }).filter(Boolean);
  list.forEach(function(p) {
    if (p[0] === '-') throw refuse('folder-archive: the pattern "' + p + '" cannot start with "-".', 'BAD_ARGUMENT');
  });
  return list;
}

/** What tar is asked to pack: from the tenant folder, its entries except backups/ and tmp/; else the folder itself. */
function targetOf(input) {
  var root = fs.realpathSync(dataDir.tenantFolder());
  var asked = String(input.folder === undefined || input.folder === null ? '' : input.folder).trim();
  var dir = asked === '' || asked === '.' ? root : dataDir.resolve(asked, 'The folder');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw refuse('"' + asked + '" is not a folder that exists.', 'NOT_A_FOLDER');
  var rel = path.relative(root, dir);
  var top = rel.split(path.sep)[0];
  if (rel && NEVER.indexOf(top) >= 0) {
    throw refuse('folder-archive: ' + top + '/ holds the backups and temporary files themselves — name a folder beside it.', 'PATH_NOT_ALLOWED');
  }
  if (!rel) {
    var entries = fs.readdirSync(root).filter(function(n) { return NEVER.indexOf(n) < 0; }).sort();
    if (!entries.length) throw refuse('folder-archive: there is nothing in this company\'s folder to back up.', 'NOTHING_TO_ARCHIVE');
    return { dir: root, rel: '', cwd: root, members: entries };
  }
  return { dir: dir, rel: rel, cwd: path.dirname(dir), members: [path.basename(dir)] };
}

module.exports = {
  name: 'folder-archive',
  example: { filePath: '/data/app/backups/uploads-2026-11-13T02-00-05.tar.gz', fileName: 'uploads-2026-11-13T02-00-05.tar.gz', bytes: 10485760,
    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', folder: 'uploads', warning: null },
  description: 'Pack a folder of this company\'s data folder into one .tar.gz backup file (its backups/ and tmp/ always left out). Returns { filePath, fileName, bytes, sha256, folder, warning }.',
  requires: [],   // tar is checked when it runs

  inputSchema: [
    { name: 'folder', type: 'string', order: 1,
      description: 'A folder in this company\'s data folder, e.g. uploads. Blank or "." for all of it.' },
    { name: 'exclude', type: 'string', order: 2,
      description: 'Names or patterns to leave out, comma separated — e.g. node_modules, *.log.' },
    { name: 'fileName', type: 'string', order: 3, group: 'File',
      description: 'The archive\'s name. Default: <folder>-<time>.tar.gz.' }
  ],
  outputSchema: [
    { name: 'filePath', type: 'string' }, { name: 'fileName', type: 'string' }, { name: 'bytes', type: 'number' },
    { name: 'sha256', type: 'string' }, { name: 'folder', type: 'string' }, { name: 'warning', type: 'string' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var system = ctx.system || {};
    var target = targetOf(input);
    var excludes = excludesOf(input.exclude);
    var outDir = dataDir.resolve(OUT_FOLDER, 'The backup folder');
    fs.mkdirSync(outDir, { recursive: true });
    var name = input.fileName ? String(input.fileName) : slugOf(target.rel) + '-' + stamp(new Date()) + '.tar.gz';
    var filePath = dataDir.resolve(path.join(outDir, name), 'The backup file');
    if (path.dirname(filePath) !== fs.realpathSync(outDir)) throw refuse('folder-archive: fileName "' + name + '" must be a name, not a path.', 'PATH_NOT_ALLOWED');
    var partial = filePath + '.partial';

    var args = ['-czf', partial].concat(excludes.map(function(p) { return '--exclude=' + p; }), ['-C', target.cwd, '--'], target.members);
    var stderr = '';
    var child;
    var code = await new Promise(function(resolve, reject) {
      try {
        child = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        reject(e);
        return;
      }
      child.on('error', function(e) { reject(e.code === 'ENOENT' ? refuse('tar is not installed on this server.', 'PROGRAM_NOT_FOUND') : e); });
      child.stderr.on('data', function(d) { stderr = (stderr + d.toString()).slice(-STDERR_KEEP); });
      var onAbort = function() { if (child.exitCode === null) child.kill('SIGTERM'); };
      if (system.signal) {
        if (system.signal.aborted) onAbort();
        else system.signal.addEventListener('abort', onAbort, { once: true });
      }
      child.on('close', function(c, signal) {
        if (system.signal) system.signal.removeEventListener('abort', onAbort);
        if (signal) return reject(refuse('tar was stopped (' + signal + ').', 'ARCHIVE_FAILED'));
        resolve(c);
      });
    }).catch(function(err) {
      try { fs.unlinkSync(partial); } catch (_) {}
      throw err;
    });
    var said = stderr.trim().split('\n').slice(-3).join(' ');
    if (code !== 0 && code !== 1) {
      try { fs.unlinkSync(partial); } catch (_) {}
      throw refuse('tar ended with code ' + code + (said ? ': ' + said : ''), 'ARCHIVE_FAILED');
    }
    fs.renameSync(partial, filePath);
    var hash = crypto.createHash('sha256');
    await new Promise(function(resolve, reject) {
      fs.createReadStream(filePath).on('data', function(d) { hash.update(d); }).on('end', resolve).on('error', reject);
    });
    return {
      filePath: filePath, fileName: path.basename(filePath), bytes: fs.statSync(filePath).size, sha256: hash.digest('hex'),
      folder: target.rel || '.', warning: code === 1 ? (said || 'some files changed while they were read') : null
    };
  },

  // For tests.
  _targetOf: targetOf,
  _excludesOf: excludesOf
};
