// File format factory. Each action calls getFormat(type) to get the right
// parser, then invokes the common parser interface.
//
// Adding a new format = add a file here + register it below.

var FORMATS = {
  excel: function() { return require('./excel'); },
  csv:   function() { return require('./csv'); },
  txt:   function() { return require('./txt'); },
  json:  function() { return require('./json'); }
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
 * opts: the format's own options (`sheet` for excel), plus `examples`.
 */
async function scanPastedRows(type, filePath, opts) {
  var format = getFormat(type);
  var config = opts || {};
  var rows = format.inputMode === 'path'
    ? format.parsePath(filePath, config)
    : format.parseStream(require('fs').createReadStream(filePath), config);
  return pastedRows.scanForPastedRows(rows, { examples: config.examples });
}

var pastedRows = require('./pastedRows');

module.exports = {
  getFormat: getFormat,
  checkFormatRequires: checkFormatRequires,
  SUPPORTED: Object.keys(FORMATS),
  scanPastedRows: scanPastedRows,
  // decodeOoxml, splitPastedRows, expandPastedRows, scanForPastedRows
  pastedRows: pastedRows
};
