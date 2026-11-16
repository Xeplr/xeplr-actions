// File format factory. Each action calls getFormat(type) to get the right
// parser, then invokes the common parser interface.
//
// Adding a new format = add a file here + register it below.

var FORMATS = {
  excel: function() { return require('./excel'); },
  csv:   function() { return require('./csv'); },
  txt:   function() { return require('./txt'); },
  json:  function() { return require('./json'); },
  parquet: function() { return require('./parquet'); }
};

function getFormat(type) {
  var loader = FORMATS[type];
  if (!loader) {
    throw new Error('Unknown format: "' + type + '". Supported: ' + Object.keys(FORMATS).join(', '));
  }
  return loader();
}

function checkFormatRequires(actionName, format, mod) {
  var requires = (mod && mod.requires) || [];
  for (var i = 0; i < requires.length; i++) {
    // A package of data files (a font) has no main to resolve; its
    // package.json says it is installed just as well.
    try { require.resolve(requires[i]); }
    catch (_) { try { require.resolve(requires[i] + '/package.json'); continue; } catch (__) { /* missing — fall through */ }
      throw new Error(
        actionName + ' requires "' + requires[i] + '" for format="' + format + '". ' +
        'Install with: npm install ' + requires[i]
      );
    }
  }
}

/**
 * Which cells of a file hold rows a paste folded into them (pastedRows.js),
 * read without changing anything — for an import's inspect step.
 * opts: the format's own options (`sheet` for excel), plus `examples`, and
 * for a file that takes a while (a CSV of gigabytes reads every row):
 *   onProgress({ rowsRead, bytesRead, bytes })  about once a second, and at
 *                 the end; bytesRead is null for a format read by path (Excel)
 *   signal        an AbortSignal: the scan stops within a row and throws
 *                 (code 'ABORTED')
 */
async function scanPastedRows(type, filePath, opts) {
  var fs = require('fs');
  var format = getFormat(type);
  var config = opts || {};
  var stream = format.inputMode === 'path' ? null : fs.createReadStream(filePath);
  var rows = stream ? format.parseStream(stream, config) : format.parsePath(filePath, config);
  try {
    if (!config.onProgress && !config.signal) return await pastedRows.scanForPastedRows(rows, { examples: config.examples });
    var bytes = fs.statSync(filePath).size;
    var counter = { rowsRead: 0 };
    var say = function() {
      if (config.onProgress) config.onProgress({ rowsRead: counter.rowsRead, bytesRead: stream ? stream.bytesRead : null, bytes: bytes });
    };
    var found = await pastedRows.scanForPastedRows(watched(rows, counter, config.signal, say), { examples: config.examples });
    say();
    return found;
  } finally {
    if (stream) stream.destroy();
  }
}

var SAY_EVERY_MS = 1000;

/** `rows` as they are, counted, saying how far about once a second, stopping when `signal` aborts. */
async function* watched(rows, counter, signal, say) {
  var said = Date.now();
  for await (var row of rows) {
    if (signal && signal.aborted) throw Object.assign(new Error('Stopped'), { code: 'ABORTED' });
    counter.rowsRead++;
    if ((counter.rowsRead & 1023) === 0 && Date.now() - said >= SAY_EVERY_MS) { said = Date.now(); say(); }
    yield row;
  }
}

/**
 * A file's column names — its header (CSV), one sheet's (Excel), or the first
 * record's keys (JSON) — read from the first row, the rest left unread. What
 * an import compares with an existing table before loading anything.
 * opts: the format's own options (`sheet` for excel).
 */
async function columnsOf(type, filePath, opts) {
  var format = getFormat(type);
  var config = opts || {};
  var rows = format.inputMode === 'path'
    ? format.parsePath(filePath, config)
    : format.parseStream(require('fs').createReadStream(filePath), config);
  var iterator = rows[Symbol.asyncIterator]();
  try {
    var first = await iterator.next();
    return first.done || !first.value ? [] : Object.keys(first.value);
  } finally {
    if (typeof iterator.return === 'function') await iterator.return();
  }
}

var pastedRows = require('./pastedRows');

module.exports = {
  getFormat: getFormat,
  checkFormatRequires: checkFormatRequires,
  SUPPORTED: Object.keys(FORMATS),
  scanPastedRows: scanPastedRows,
  columnsOf: columnsOf,
  // decodeOoxml, splitPastedRows, expandPastedRows, scanForPastedRows
  pastedRows: pastedRows
};
