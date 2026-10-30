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
var path = require('path');
var readline = require('readline');
var writers = require('../../formats/writers');
var { checkFormatRequires } = require('../../formats');
var fileNames = require('../../fileNames');

var dataDir = require('../../dataDir');

/** A file name from a title: what a person would recognise in their downloads. */
function fileNameFor(title, extension) {
  var base = String(title || 'export').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'export';
  return base + '.' + extension;
}

/**
 * A ROW AS THE WRITERS TAKE IT: { values: [...] }. A plain record — what a
 * fetch or the data step gives, { ref: 'A1', amount: 500 } — is laid out by
 * the columns' `key` (or header), so a workflow can hand its rows straight
 * over instead of reshaping them first.
 */
function asRow(row, columns) {
  if (row && Array.isArray(row.values)) return row;
  var r = row || {};
  return { values: columns.map(function(c) { var k = c.key || c.header; return r[k] === undefined ? null : r[k]; }) };
}

async function* rowsFrom(input, columns) {
  if (Array.isArray(input.rows)) { for (var i = 0; i < input.rows.length; i++) yield asRow(input.rows[i], columns); return; }
  var lines = readline.createInterface({ input: fs.createReadStream(dataDir.resolve(input.rowsFile, 'The rows file')), crlfDelay: Infinity });
  for await (var line of lines) if (line.trim()) yield asRow(JSON.parse(line), columns);
}

/** Columns for plain records when none are given: every key of the first one, as it is. */
function columnsOf(rows) {
  var first = (rows || []).find(function(r) { return r && typeof r === 'object' && !Array.isArray(r.values); });
  return first ? Object.keys(first).map(function(k) { return { header: k, key: k }; }) : [];
}

module.exports = {
  name: 'export-table',
  description: 'Write rows to a CSV, Excel (.xlsx) or PDF file. Excel cells stay numbers with their number format; ' +
               'a PDF shows each cell as it was displayed.',
  requires: [],

  inputSchema: [
    { name: 'format', type: 'string', required: true, order: 1, enum: writers.SUPPORTED,
      description: 'csv, xlsx or pdf.' },
    { name: 'document', type: 'object', order: 2,
      description: '{ title?, subtitle?, footer?, columns: [{ header, key?, kind?: number|date|text, numFmt?, align?, width? }] }. ' +
                   'numFmt is an Excel number format ("#,##0.00", "0.0%", "mmm yyyy"). key: which field of a plain record ' +
                   'goes in the column (default: the header). No columns with plain records: every field of the first row.' },
    { name: 'rows', type: 'array', order: 3,
      description: 'Plain records, as a fetch or the data step gives them ({ ref, amount }), or { values: [], display?: [], ' +
                   'kind?: detail|subtotal|total }. Or give rowsFile.' },
    { name: 'rowsFile', type: 'string', order: 4,
      description: 'An NDJSON file with one row per line, instead of rows.' },
    { name: 'outputPath', type: 'string', order: 5,
      description: 'Where to write, e.g. /data/recon/Recon-{trigger.window.from|date:YYYY-MM}.xlsx. ' +
                   'In this company\'s data folder, e.g. exports/sales.xlsx. Default: a new file in its tmp/ folder named after the title.' },
    { name: 'ifExists', type: 'string', order: 7, default: 'fail', options: fileNames.IF_EXISTS,
      description: 'When outputPath is already there. fail: the step fails and nothing is written. skip: left alone ' +
                   '(skipped: true). overwrite: replaced. addSuffix: "name (2).xlsx".' },
    { name: 'maxRows', type: 'number', order: 6,
      description: 'PDF only: rows to draw before stopping with a note (default 5,000).' }
  ],
  outputSchema: [
    { name: 'filePath', type: 'string' }, { name: 'fileName', type: 'string' },
    { name: 'contentType', type: 'string' }, { name: 'bytes', type: 'number' },
    { name: 'rows', type: 'number' }, { name: 'truncated', type: 'boolean' },
    { name: 'skipped', type: 'boolean' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var format = String(input.format || '').toLowerCase();
    var writer = writers.getWriter(format);
    checkFormatRequires('export-table', format, writer);
    var doc = Object.assign({}, input.document || {});
    if ((!Array.isArray(doc.columns) || !doc.columns.length) && Array.isArray(input.rows)) doc.columns = columnsOf(input.rows);
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
    // A name the step gives is inside the tenant's folder; none, its tmp/.
    var filePath = input.outputPath ? dataDir.resolve(input.outputPath, 'Where to save it')
      : path.join(fs.mkdtempSync(path.join(dataDir.scratch(), 'export-')), fileName);
    if (input.outputPath) {
      // The same rule as every action that saves a file (lib/fileNames.js):
      // a name already taken is never silently replaced.
      var dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      var place = fileNames.plan(dir, [path.basename(filePath)], input.ifExists)[0];
      if (!place.write) {
        return { filePath: place.path, fileName: place.name, contentType: info.contentType,
          bytes: fs.statSync(place.path).size, rows: 0, truncated: false, skipped: true };
      }
      filePath = place.path;
    }
    var open = writer.open(filePath, doc);
    var signal = ctx.signal;
    try {
      for await (var row of rowsFrom(input, doc.columns)) {
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
        truncated: done.truncated,
        skipped: false
      };
    } catch (err) {
      try { fs.rmSync(filePath, { force: true }); } catch (e) { /* nothing to clean */ }
      throw err;
    }
  }
};
