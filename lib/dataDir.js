// WHERE A STEP'S FILES ARE — one data root, one folder per tenant.
//
//   XEPLR_DATA_DIR   the root of all data, absolute, required (requiredEnv)
//
// Every file a step reads or writes is inside the folder of the tenant the
// work runs as, and nowhere else:
//
//   <XEPLR_DATA_DIR>/<applicationId>/<mtId1>/<mtId2>/…
//
// The application comes from @xeplr/db's registerApplication (a company id is
// minted per app, so company 42 of BI and company 42 of ERP are two tenants);
// the tenant from the context every query already runs in — a request after
// the membership gate, a job or a workflow run (runWithMt). Never from a
// step's input: a step names `bank/inbox/sept.csv`, and cannot name anything
// outside its own folder.
//
//   a name           bank/inbox/sept.csv → inside the folder
//   a full path      accepted only when it is inside the folder already (what
//                    an earlier step returned: file-list's `path`)
//   '*' at a level   `_all` — a job for every company has a folder of its own,
//                    and no company's step can reach it
//   no tenant        refused, as a query with no tenant finds nothing; never
//                    the root
//
// `..` and symlinks are resolved before the check, so neither steps out.
// NOT DEFAULTED: "Where data lives is never defaulted." A missing or relative
// XEPLR_DATA_DIR is refused by name, and so is one that does not exist — a
// wrong root that boots reads as empty data, not as an error.

var fs = require('fs');
var path = require('path');

var VAR = 'XEPLR_DATA_DIR';
var requiredEnv = [VAR];
var ALL = '_all';
var SCRATCH = 'tmp';

function refused(message, code) {
  var err = new Error(message);
  err.code = code || 'PATH_NOT_ALLOWED';
  err.status = 400;
  return err;
}

function db() { return require('@xeplr/db'); }

/** The data root, absolute and real. */
function root() {
  var dir = process.env[VAR];
  if (!dir || !String(dir).trim()) {
    throw refused(VAR + ' is not set: it is the folder all data lives under (absolute), e.g. /srv/xeplr-data.', 'DATA_DIR_UNSET');
  }
  if (!path.isAbsolute(dir)) throw refused(VAR + ' must be an absolute folder, and "' + dir + '" is not one.', 'DATA_DIR_UNSET');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw refused(VAR + ' is "' + dir + '", which is not a folder that exists. Create it, or point ' + VAR + ' at the one that holds the data.', 'DATA_DIR_UNSET');
  }
  return fs.realpathSync(dir);
}

// An id becomes a folder name as it is. One that could not be one — or could
// climb out (`..`) — is refused rather than cleaned up into someone else's.
function segment(value, what) {
  if (value === '*') return ALL;
  var s = value === null || value === undefined ? '' : String(value);
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(s) || s === '.' || s === '..') {
    throw refused('The ' + what + ' "' + s + '" cannot name a folder.', 'NO_TENANT');
  }
  return s;
}

/**
 * The folder the current work may use: <root>/<app>/<mtId1>/…, made if it is
 * not there yet. An app with no tenancy registered is one tenant: <root>/<app>.
 */
function tenantFolder() {
  var x = db();
  var app = x.getApplicationId();
  if (!app) throw refused('No application is registered (registerApplication), so there is no folder for its files.', 'NO_TENANT');
  var parts = [root(), segment(app, 'application')];
  var levels = x.getMtConfig().levels || 0;
  var ctx = x.getMtContext() || {};
  for (var i = 1; i <= levels; i++) {
    var v = ctx['mtId' + i];
    if (v === undefined || v === null || v === '') {
      throw refused('This work runs as no tenant, so it has no folder: files are only ever inside the folder of the company it runs for.', 'NO_TENANT');
    }
    parts.push(segment(v, 'tenant id'));
  }
  var dir = path.join.apply(path, parts);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

/** The tenant's own temporary folder: spools, downloads, exports nobody named. */
function scratch() {
  var dir = path.join(tenantFolder(), SCRATCH);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function inside(real, folder) {
  return real === folder || real.indexOf(folder + path.sep) === 0;
}

/**
 * A name (or a full path already inside the folder) → the real absolute path,
 * inside the tenant's folder; refused otherwise. A path that does not exist
 * yet (a move's target, an export) is checked by its nearest existing parent,
 * so `../` and symlinks cannot step out.
 */
function resolve(p, what) {
  if (!p || typeof p !== 'string' || !p.trim()) throw refused((what || 'A path') + ' is required.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) throw refused((what || 'The path') + ' "' + p + '" is an address, not a file in this company\'s folder.');
  var folder = tenantFolder();
  var resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(folder, p);
  var probe = resolved;
  var rest = '';
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
    rest = path.join(path.basename(probe), rest);
    probe = path.dirname(probe);
  }
  var real = path.join(fs.realpathSync(probe), rest);
  if (!inside(real, folder)) {
    throw refused((what || 'The path') + ' "' + p + '" is outside this company\'s folder. Name it inside, e.g. bank/inbox/statement.csv.');
  }
  return real;
}

/** The name a path has inside the tenant's folder — what a screen shows. */
function nameOf(real) {
  var folder = tenantFolder();
  return inside(real, folder) ? path.relative(folder, real) : null;
}

module.exports = { VAR: VAR, requiredEnv: requiredEnv, ALL: ALL, root: root, tenantFolder: tenantFolder, scratch: scratch, resolve: resolve, nameOf: nameOf };
