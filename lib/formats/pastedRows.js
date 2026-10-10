// ROWS PASTED INTO ONE CELL — found, and put back.
//
// Data copied out of an ERP is tab-separated text, a row per line. Pasted into
// Excel, a value that STARTS with a double quote (an inch mark: `"4 INCH`)
// switches Excel into quoted mode, and everything up to the next `"` — tabs,
// line breaks, whole rows — lands in that one cell. The sheet then holds one
// row whose cell carries the next N rows, and those rows exist nowhere else.
// Seen for real: 465 rows folded into 11 Item Description cells.
//
// The damage has an exact shape, which is what makes it safe to undo:
//
//   cell = <its own row's value> \t <its own row's remaining columns>
//          \n <a whole row> \n <a whole row> …
//          \n <the last row's columns up to and including this one>
//
// and the merged row's OTHER columns after the cell belong to that last row.
// So the cell splits on its line breaks into a first piece of (n - c) values,
// whole rows of n values, and a last piece of L values — n columns, the cell
// at column c. Usually L is c + 1 (the closing quote was in the same column);
// when it closed in a later column k, L is k + 1, and the last row's
// remaining (n - L) values sit in the merged row's cells right after c, the
// cells beyond them empty. A cell that does not split exactly like that is
// left alone: ordinary multi-line text never has those counts, so a genuine
// note with line breaks is never "repaired".
//
// The quote that opened the cell and the one that closed it were eaten by the
// paste; they are put back — at the start of the first row's value, where
// quoted mode began, and at the end of the last row's value where it ended
// (an inch mark: `Painting brush 4"`).

// Excel's own escape inside cell text: `_xHHHH_` is the character with that
// hex code. A line break inside a cell is saved as `_x000D_` + a real newline;
// `_x005F_` is a literal underscore, which is how text that really says
// "_x000D_" is stored ("_x005F_x000D_") — left to right, that decodes right.
var ESCAPE = /_x([0-9A-Fa-f]{4})_/g;

function decodeOoxml(s) {
  if (typeof s !== 'string' || s.indexOf('_x') === -1) return s;
  return s.replace(ESCAPE, function(_, hex) { return String.fromCharCode(parseInt(hex, 16)); });
}

var LINE = /\r\n|\r|\n/;
var NUMBER = /^-?\d+(\.\d+)?$/;

// A value from inside the cell: text, typed as the sheet's own cells would be.
function cast(v) {
  if (v === '') return null;
  return NUMBER.test(v) ? Number(v) : v;
}

/**
 * The rows folded into one of `rec`'s cells, put back — or null when no cell
 * has that exact shape. `headers` in sheet order.
 *
 * @returns {{ column: string, rows: object[] } | null}  rows[0] is `rec` itself, rebuilt
 */
function splitPastedRows(rec, headers) {
  var n = headers.length;
  for (var c = 0; c < n; c++) {
    var cell = decodeOoxml(rec[headers[c]]);
    if (typeof cell !== 'string' || cell.indexOf('\t') === -1 || !LINE.test(cell)) continue;
    var lines = cell.split(LINE);
    var first = lines[0].split('\t');
    var last = lines[lines.length - 1].split('\t');
    var middle = lines.slice(1, -1).map(function(l) { return l.split('\t'); });
    var L = last.length;
    if (first.length !== n - c || L < c + 1 || L > n) continue;
    if (middle.some(function(m) { return m.length !== n; })) continue;
    // The last row's values after the closing quote: the merged row's cells
    // right after c — and every cell beyond those must be empty, or this is
    // not the shape a paste leaves.
    var tail = headers.slice(c + 1, c + 1 + (n - L));
    var beyond = headers.slice(c + 1 + (n - L));
    if (beyond.some(function(h) { return rec[h] !== null && rec[h] !== undefined && rec[h] !== ''; })) continue;

    var rows = [];
    var top = {};
    headers.forEach(function(h, i) { top[h] = i < c ? rec[h] : cast(first[i - c]); });
    top[headers[c]] = '"' + first[0];
    rows.push(top);
    middle.forEach(function(m) {
      var r = {};
      headers.forEach(function(h, i) { r[h] = cast(m[i]); });
      rows.push(r);
    });
    var end = {};
    headers.forEach(function(h, i) { end[h] = i < L ? cast(last[i]) : rec[tail[i - L]]; });
    // The closing quote, at the end of the value it closed.
    end[headers[L - 1]] = String(last[L - 1]) + '"';
    rows.push(end);
    return { column: headers[c], rows: rows };
  }
  return null;
}

/**
 * Rows as they were before the paste folded them: each record whose cell
 * holds pasted rows becomes those rows. Everything else passes through.
 * `onRepair({ row, column, rows })` hears each one (row: 1-based data row).
 */
async function* expandPastedRows(records, onRepair) {
  var headers = null;
  var index = 0;
  for await (var rec of records) {
    index++;
    if (!headers) headers = Object.keys(rec);
    var split = splitPastedRows(rec, headers);
    if (!split) { yield rec; continue; }
    if (onRepair) onRepair({ row: index, column: split.column, rows: split.rows.length - 1 });
    for (var r of split.rows) yield r;
  }
}

/**
 * Read a whole file's rows and say which cells hold pasted rows, without
 * changing anything — for the inspect step, before anything is loaded.
 *
 * @returns {{ cells: number, rows: number, examples: [{ row, column, rows, first }] }}
 *          rows: how many rows the repair would recover
 */
async function scanForPastedRows(records, opts) {
  var limit = (opts && opts.examples) || 5;
  var headers = null;
  var index = 0;
  var found = { cells: 0, rows: 0, examples: [] };
  for await (var rec of records) {
    index++;
    if (!headers) headers = Object.keys(rec);
    var split = splitPastedRows(rec, headers);
    if (!split) continue;
    found.cells++;
    found.rows += split.rows.length - 1;
    if (found.examples.length < limit) {
      found.examples.push({ row: index, column: split.column, rows: split.rows.length - 1,
        first: String(split.rows[0][split.column]).slice(0, 80) });
    }
  }
  return found;
}

module.exports = {
  decodeOoxml: decodeOoxml,
  splitPastedRows: splitPastedRows,
  expandPastedRows: expandPastedRows,
  scanForPastedRows: scanForPastedRows
};
