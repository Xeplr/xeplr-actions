// CSV writer — the raw values, nothing formatted.
//
// RFC 4180: a field is quoted when it holds the delimiter, a quote, or a line
// break, and a quote inside is doubled. A UTF-8 byte order mark leads the
// file: without it Excel on Windows reads the file as the system code page
// and "₹" or "São Paulo" arrive as mojibake. Every other reader ignores it.
//
// A Date is written as ISO 8601 (YYYY-MM-DD when it is a whole UTC day), a
// boolean as true/false, null as an empty field.
//
// A field that would start with = + - @ (or a tab / carriage return) is
// prefixed with an apostrophe when `safe` is on (default): opened in a
// spreadsheet, such a cell is a FORMULA, and a value somebody typed into a
// source system would run on the reader's machine (CSV injection). Off for a
// file meant for another program rather than a person.

var fs = require('fs');

function isoOf(d) {
  if (isNaN(d.getTime())) return '';
  var iso = d.toISOString();
  return iso.slice(10) === 'T00:00:00.000Z' ? iso.slice(0, 10) : iso;
}

module.exports = {
  requires: [],

  /**
   * @param {string} filePath
   * @param {object} doc - { columns: [{ header }], delimiter?: ',', safe?: true }
   * @returns {{ writeRow(row): Promise<boolean>, close(): Promise<{ rows, truncated }> }}
   */
  open: function(filePath, doc) {
    var delimiter = doc.delimiter || ',';
    var safe = doc.safe !== false;
    var out = fs.createWriteStream(filePath);
    var failed = null;
    out.on('error', function(err) { failed = err; });
    var rows = 0;
    var buffered = '';

    function field(value) {
      if (value === null || value === undefined) return '';
      var text = value instanceof Date ? isoOf(value) : String(value);
      if (safe && typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
      if (text.indexOf(delimiter) !== -1 || /["\r\n]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
      return text;
    }
    function line(values) { return values.map(field).join(delimiter) + '\r\n'; }

    async function push(text, final) {
      buffered += text;
      if (buffered.length < 1 << 20 && !final) return;
      var chunk = buffered;
      buffered = '';
      if (failed) throw failed;
      if (!out.write(chunk)) await new Promise(function(r) { out.once('drain', r); });
    }

    var started = push('﻿' + line((doc.columns || []).map(function(c) { return c.header == null ? '' : c.header; })));

    return {
      writeRow: async function(row) {
        await started;
        rows += 1;
        await push(line(row.values || []));
        return true;
      },
      close: async function() {
        await started;
        await push('', true);
        await new Promise(function(resolve, reject) { out.end(function(err) { return err ? reject(err) : resolve(); }); });
        if (failed) throw failed;
        return { rows: rows, truncated: false };
      }
    };
  }
};
