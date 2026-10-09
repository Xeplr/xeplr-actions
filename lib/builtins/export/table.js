// export-table — rows to a CSV, Excel or PDF file.
//
// The rows arrive already DECIDED: which columns, in what order, under what
// heading, and for each cell both its raw value and the text a reader saw.
// This action does not know what a report or a pivot is; whoever calls it
// worked that out (in BI, report-engine's presentTable). Each format takes
// what it needs from a row:
//
//   csv   the raw values, unformatted — a file for another program
//   xlsx  the raw values as TYPED cells carrying each column's number format,
//         so the sheet looks like the screen and still sums
//   pdf   the display text, exactly as shown
//
// Rows come inline (`rows`) or from an NDJSON file (`rowsFile`, one row per
// line — what streaming/spool writes), so a large result never has to be one
// array in memory. CSV and Excel stream; a PDF holds its rows (capped, 5,000 by
// default) because a page is laid out from them.

var fs = require('fs');
var os = require('os');
var path = require('path');
var readline = require('readline');
var writers = require('../../formats/writers');
var { checkFormatRequires } = require('../../formats');

function tmpDir() {
  var dir = process.env.XEPLR_ACTIONS_TMP_DIR || path.join(os.tmpdir(), 'xeplr-actions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A file name from a title: what a person would recognise in their downloads. */
function fileNameFor(title, extension) {
  var base = String(title || 'export').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'export';
  return base + '.' + extension;
}

async function* rowsFrom(input) {
  if (Array.isArray(input.rows)) { for (var i = 0; i < input.rows.length; i++) yield input.rows[i]; return; }
  var lines = readline.createInterface({ input: fs.createReadStream(input.rowsFile), crlfDelay: Infinity });
  for await (var line of lines) if (line.trim()) yield JSON.parse(line);
}

module.exports = {
  name: 'export-table',
  description: 'Write rows to a CSV, Excel (.xlsx) or PDF file. Excel cells stay numbers with their number format; ' +
               'a PDF shows each cell as it was displayed.',
  requires: [],

  inputSchema: [
    { name: 'format', type: 'string', required: true, order: 1, enum: writers.SUPPORTED,
      description: 'csv, xlsx or pdf.' },
    { name: 'document', type: 'object', required: true, order: 2,
      description: '{ title?, subtitle?, footer?, columns: [{ header, kind?: number|date|text, numFmt?, align?, width? }] }. ' +
                   'numFmt is an Excel number format ("#,##0.00", "0.0%", "mmm yyyy").' },
    { name: 'rows', type: 'array', order: 3,
      description: 'Rows: { values: [], display?: [], kind?: detail|subtotal|total }. Or give rowsFile.' },
    { name: 'rowsFile', type: 'string', order: 4,
      description: 'An NDJSON file with one row per line, instead of rows.' },
    { name: 'outputPath', type: 'string', order: 5,
      description: 'Where to write. Default: a new file in XEPLR_ACTIONS_TMP_DIR named after the title.' },
    { name: 'maxRows', type: 'number', order: 6,
      description: 'PDF only: rows to draw before stopping with a note (default 5,000).' }
  ],
  outputSchema: [
    { name: 'filePath', type: 'string' }, { name: 'fileName', type: 'string' },
    { name: 'contentType', type: 'string' }, { name: 'bytes', type: 'number' },
    { name: 'rows', type: 'number' }, { name: 'truncated', type: 'boolean' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var format = String(input.format || '').toLowerCase();
    var writer = writers.getWriter(format);
    checkFormatRequires('export-table', format, writer);
    var doc = Object.assign({}, input.document || {});
    if (!Array.isArray(doc.columns) || !doc.columns.length) {
      var bad = new Error('document.columns must list at least one column');
      bad.status = 400;
      throw bad;
    }
    if (!Array.isArray(input.rows) && !input.rowsFile) {
      var none = new Error('Give rows, or a rowsFile');
      none.status = 400;
      throw none;
    }
    if (format === 'pdf' && input.maxRows) doc.maxRows = input.maxRows;

    var info = writers.INFO[format];
    var fileName = fileNameFor(doc.title, info.extension);
    var filePath = input.outputPath || path.join(fs.mkdtempSync(path.join(tmpDir(), 'export-')), fileName);
    var open = writer.open(filePath, doc);
    var signal = ctx.signal;
    try {
      for await (var row of rowsFrom(input)) {
        if (signal && signal.aborted) throw new Error('Stopped by request');
        var more = await open.writeRow(row);
        // Excel's own limit: the rest are only counted. A PDF keeps counting
        // too, so its closing note can say how many were left out.
        if (more === false && format === 'xlsx') { /* keep reading to count */ }
      }
      var done = await open.close();
      return {
        filePath: filePath,
        fileName: path.basename(filePath),
        contentType: info.contentType,
        bytes: fs.statSync(filePath).size,
        rows: done.rows,
        truncated: done.truncated
      };
    } catch (err) {
      try { fs.rmSync(filePath, { force: true }); } catch (e) { /* nothing to clean */ }
      throw err;
    }
  }
};
