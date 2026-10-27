// WHERE A FILE STEP MAY LOOK.
//
// file-list, file-read and file-move take a path from whoever wrote the
// workflow. Unbounded, that is every file the server can read: its own
// settings, other installs' data. So they work only inside the folders the
// install names:
//
//   XEPLR_FILE_ROOTS   absolute folders, comma-separated, e.g. /data/bank,/data/erp
//
// plus XEPLR_ACTIONS_TMP_DIR (or the system temp folder's xeplr-actions),
// where downloads and exports land by default, so the file a step just saved
// can be read by the next one.
//
// NOT DEFAULTED: no roots configured and a path outside the temp folder is
// refused, naming the variable. "Where data lives is never defaulted."

var fs = require('fs');
var os = require('os');
var path = require('path');

function rootsError(message) {
  var err = new Error(message);
  err.code = 'PATH_NOT_ALLOWED';
  err.status = 400;
  return err;
}

function tmpRoot() {
  return path.resolve(process.env.XEPLR_ACTIONS_TMP_DIR || path.join(os.tmpdir(), 'xeplr-actions'));
}

/** The folders a file step may use, resolved and real (symlinks followed). */
function roots() {
  var listed = String(process.env.XEPLR_FILE_ROOTS || '').split(',')
    .map(function(r) { return r.trim(); })
    .filter(Boolean);
  listed.forEach(function(r) {
    if (!path.isAbsolute(r)) throw rootsError('XEPLR_FILE_ROOTS must list absolute folders, and "' + r + '" is not one.');
  });
  return listed.concat([tmpRoot()]).map(function(r) {
    try { return fs.realpathSync(r); } catch (e) { return path.resolve(r); }
  });
}

/**
 * The path, absolute and real, when it is inside an allowed folder; refused
 * otherwise. A path that does not exist yet (a move's target) is checked by
 * its nearest existing parent, so "../" and symlinks cannot step outside.
 */
function allowed(p, what) {
  if (!p || typeof p !== 'string') throw rootsError((what || 'A path') + ' is required.');
  if (!path.isAbsolute(p)) throw rootsError((what || 'The path') + ' "' + p + '" must be absolute, e.g. /data/bank/statement.csv.');
  var resolved = path.resolve(p);
  var probe = resolved;
  var rest = '';
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    rest = path.join(path.basename(probe), rest);
    probe = path.dirname(probe);
  }
  var real = path.join(fs.realpathSync(probe), rest);
  var ok = roots().some(function(r) { return real === r || real.indexOf(r + path.sep) === 0; });
  if (!ok) {
    throw rootsError((what || 'The path') + ' "' + p + '" is outside the folders file steps may use. ' +
      (process.env.XEPLR_FILE_ROOTS
        ? 'Allowed: ' + process.env.XEPLR_FILE_ROOTS + ' and the temp folder.'
        : 'Set XEPLR_FILE_ROOTS to the folders they may use (absolute, comma-separated).'));
  }
  return real;
}

module.exports = { allowed: allowed, roots: roots, tmpRoot: tmpRoot };
