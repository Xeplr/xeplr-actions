// file-read action — a CSV, Excel, JSON or NDJSON file as rows.
//
// What the next step works with: the data step filters them, export-table
// writes them, a matcher compares them. Only inside the tenant's own folder
// (lib/dataDir.js). Bounded by maxRows, because a step's output is
// stored with the run.

var path = require('path');
var fs = require('fs');
var readline = require('readline');
var dataDir = require('../../dataDir');
var formats = require('../../formats');

var BY_EXTENSION = { csv: 'csv', txt: 'txt', tsv: 'txt', xlsx: 'excel', xls: 'excel', json: 'json', ndjson: 'ndjson', jsonl: 'ndjson' };

async function* ndjsonRows(file) {
  var lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (var line of lines) if (line.trim()) yield JSON.parse(line);
}

module.exports = {
  name: 'file-read',
  description: 'Read a CSV, Excel (.xlsx), JSON or NDJSON file into rows. Returns { rows, count, columns, truncated }.',
  requires: [],
  inputSchema: [
    { name: 'path', type: 'string', required: true, order: 1,
      description: 'A file in this company\'s data folder, e.g. bank/inbox/sept.csv or {item.path}.' },
    { name: 'format', type: 'string', order: 2, options: ['csv', 'txt', 'excel', 'json', 'ndjson'],
      description: 'Empty: from the file\'s extension.' },
    { name: 'sheet', type: 'string', order: 3, group: 'Excel',
      description: 'Which sheet. Empty: the first.' },
    { name: 'maxRows', type: 'number', default: 50000, order: 4,
      description: 'Rows to read before stopping (truncated: true). A step\'s rows are stored with the run.' }
  ],
  outputSchema: [
    { name: 'rows', type: 'array' }, { name: 'count', type: 'number' },
    { name: 'columns', type: 'array', description: 'The file\'s columns, in order: [{ key, header }].' },
    { name: 'truncated', type: 'boolean' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var file = dataDir.resolve(input.path, 'The file');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      var missing = new Error('"' + input.path + '" is not a file that exists.');
      missing.code = 'FILE_NOT_FOUND';
      throw missing;
    }
    var ext = path.extname(file).slice(1).toLowerCase();
    var kind = input.format || BY_EXTENSION[ext];
    if (!kind) {
      var unknown = new Error('Cannot tell how to read ".' + ext + '". Set format: csv, txt, excel, json or ndjson.');
      unknown.code = 'FORMAT_UNKNOWN';
      throw unknown;
    }
    var source;
    if (kind === 'ndjson') {
      source = ndjsonRows(file);
    } else {
      var reader = formats.getFormat(kind);
      formats.checkFormatRequires('file-read', kind, reader);
      var opts = input.sheet ? { sheet: input.sheet } : {};
      source = reader.inputMode === 'path' ? reader.parsePath(file, opts) : reader.parseStream(fs.createReadStream(file), opts);
    }
    var max = Math.max(1, Number(input.maxRows) || 50000);
    var rows = [];
    var truncated = false;
    for await (var row of source) {
      if (rows.length >= max) { truncated = true; break; }
      rows.push(row);
    }
    // The order of the file's own columns, said out loud: a step's output is
    // stored as JSONB, which reorders a row's keys.
    var columns = rows.length ? Object.keys(rows[0]).map(function(k) { return { key: k, header: k }; }) : [];
    return { rows: rows, count: rows.length, columns: columns, truncated: truncated };
  }
};
