// _xlsx-stream — constant-memory streaming reader for .xlsx worksheets.
//
// Ported from polus/db.helpers/xlsxStreamReader.js. See MEMORY entry
// [[polus-xlsxstreamreader]] for the origin.
//
// WHY THIS EXISTS: the `xlsx-stream-reader` npm package matches on the FULL
// tag name (`<row>`, `<c>`). Files authored by the .NET OpenXML SDK — which
// includes SharePoint downloads and Microsoft Graph exports — emit the SAME
// OOXML schema but with a namespace PREFIX (`<x:row>`, `<x:c>`). That reader
// then matches nothing, walks the WHOLE worksheet XML looking for tags that
// never appear, and burns unbounded heap. This reader matches on the LOCAL
// name (prefix stripped), so it reads both.
//
// It streams the worksheet part through `unzipper` (the 1.3GB-XML case is
// entirely disk-bound; peak RSS on a 84MB SharePoint xlsx is ~130MB) and
// SAX-parses rows with `saxes`. sharedStrings is loaded once (streamed too)
// only when present; inline-string files skip that entirely.
//
// Interface:
//
//   stream_xlsx_sheet_rows(filePath, sheet_name, { onHeaders, onRow })
//     -> Promise<{ sheet_name, headers, row_count, part, date_columns }>
//
// Dates arrive in each onRow record as JS Date objects (Excel has no date
// cell type; a date is a numeric cell whose style resolves to a date
// number-format via styles.xml).

var unzipper = require('unzipper');
var { SaxesParser } = require('saxes');
var { StringDecoder } = require('string_decoder');

// Strip an XML namespace prefix: "x:row" -> "row", "row" -> "row".
function localName(n) {
  if (!n) return n;
  var i = n.indexOf(':');
  return i === -1 ? n : n.slice(i + 1);
}

// Read an attribute by its LOCAL name (handles prefixed attrs like r:id).
function attr(attributes, key) {
  if (!attributes) return undefined;
  var keys = Object.keys(attributes);
  for (var j = 0; j < keys.length; j++) {
    if (localName(keys[j]) === key) {
      var v = attributes[keys[j]];
      return (v && typeof v === 'object' && 'value' in v) ? v.value : v;
    }
  }
  return undefined;
}

// ── Date detection ──────────────────────────────────────────────────────
// xlsx has NO date cell type. A date is a NUMBER whose cell style
// (`<c s="..">` indexing into styles.xml's <cellXfs>) carries a date
// number-format. We resolve style index → numFmtId → is-date.

// Built-in numFmtIds that are always date/time formats (ECMA-376 §18.8.30).
var BUILTIN_DATE_NUMFMT_IDS = new Set([14,15,16,17,18,19,20,21,22,45,46,47]);

// Does a (custom) format code describe a date/time? Strip escaped chars,
// quoted literals, and [bracketed] sections, then look for y/m/d/h/s tokens.
function isDateFormatCode(code) {
  if (!code) return false;
  var stripped = String(code)
    .replace(/\\./g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(stripped);
}

function isDateNumFmt(id, code) {
  return BUILTIN_DATE_NUMFMT_IDS.has(id) || (id >= 164 && isDateFormatCode(code));
}

// Excel serial number → JS Date (UTC). Day 0 is 1899-12-30. 25569 = days
// from 1899-12-30 to Unix epoch. 1904 system (Mac-authored files) shifts +1462.
function excelSerialToDate(serial, date1904) {
  var s = date1904 ? serial + 1462 : serial;
  return new Date(Math.round((s - 25569) * 86400000));
}

// "AB12" → 0-based column index (A=0, AB=27). Ignores trailing row digits.
function colRefToIndex(ref) {
  var col = 0;
  for (var i = 0; i < ref.length; i++) {
    var ch = ref.charCodeAt(i);
    if      (ch >= 65 && ch <=  90) col = col * 26 + (ch - 64);   // A-Z
    else if (ch >= 97 && ch <= 122) col = col * 26 + (ch - 96);   // a-z
    else break;
  }
  return col - 1;
}

// SAX-parse a whole (small) XML buffer with per-event callbacks.
function saxParseString(xml, handlers) {
  var parser = new SaxesParser();
  if (handlers.opentag)  parser.on('opentag',  handlers.opentag);
  if (handlers.text)     parser.on('text',     handlers.text);
  if (handlers.closetag) parser.on('closetag', handlers.closetag);
  parser.write(xml);
  parser.close();
}

// SAX-parse a STREAMED zip entry, decoding bytes safely across chunk boundaries.
function saxParseStream(readable, handlers) {
  return new Promise(function(resolve, reject) {
    var parser = new SaxesParser();
    if (handlers.opentag)  parser.on('opentag',  handlers.opentag);
    if (handlers.text)     parser.on('text',     handlers.text);
    if (handlers.closetag) parser.on('closetag', handlers.closetag);
    parser.on('error', reject);
    var decoder = new StringDecoder('utf8');
    readable.on('data', function(chunk) {
      try { parser.write(decoder.write(chunk)); } catch (e) { reject(e); }
    });
    readable.on('end', function() {
      try { parser.write(decoder.end()); parser.close(); resolve(); } catch (e) { reject(e); }
    });
    readable.on('error', reject);
  });
}

function findFile(directory, p) { return directory.files.find(function(f) { return f.path === p; }); }

async function readEntryText(directory, p) {
  var f = findFile(directory, p);
  if (!f) return null;
  var buf = await f.buffer();
  return buf.toString('utf8');
}

// workbook.xml → [{ name, rId }] in document order.
function parseWorkbookSheets(xml) {
  if (!xml) return [];
  var sheets = [];
  saxParseString(xml, {
    opentag: function(tag) {
      if (localName(tag.name) === 'sheet') {
        sheets.push({ name: attr(tag.attributes, 'name'), rId: attr(tag.attributes, 'id') });
      }
    }
  });
  return sheets;
}

// workbook.xml.rels → { rId: target }
function parseRels(xml) {
  var map = {};
  if (!xml) return map;
  saxParseString(xml, {
    opentag: function(tag) {
      if (localName(tag.name) === 'Relationship') {
        var id     = attr(tag.attributes, 'Id');
        var target = attr(tag.attributes, 'Target');
        if (id) map[id] = target;
      }
    }
  });
  return map;
}

// rels Target → absolute zip part path. Usually relative to xl/,
// e.g. "worksheets/sheet2.xml"; may be absolute ("/xl/worksheets/sheet2.xml").
function relTargetToPart(target) {
  if (!target) return null;
  if (target.startsWith('/')) return target.slice(1);
  return 'xl/' + target.replace(/^\.\//, '');
}

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

// Resolve requested sheet (by name; else first) → zip part path.
function resolveTargetPart(sheets, rels, sheet_name, directory) {
  var withPart = sheets.map(function(s) { return Object.assign({}, s, { part: relTargetToPart(rels[s.rId]) }); });
  var chosen = sheet_name
    ? withPart.find(function(s) { return norm(s.name) === norm(sheet_name); })
    : withPart[0];
  if (!chosen && sheet_name && withPart.length === 1) chosen = withPart[0];
  if (chosen && chosen.part && findFile(directory, chosen.part)) return chosen;

  // Last resort: the largest xl/worksheets/sheetN.xml part actually present
  // (handles broken/missing rels — the data is in the big worksheet part).
  var wsFiles = directory.files
    .filter(function(f) { return /xl\/worksheets\/sheet\d+\.xml$/.test(f.path); })
    .sort(function(a, b) { return (b.uncompressedSize || 0) - (a.uncompressedSize || 0); });
  if (wsFiles.length) {
    return { name: sheet_name || (chosen && chosen.name) || '(first sheet)', part: wsFiles[0].path };
  }
  return null;
}

// sharedStrings.xml → [string]. Returns null when file has none (inline strings only).
async function parseSharedStrings(directory) {
  var f = findFile(directory, 'xl/sharedStrings.xml');
  if (!f) return null;
  var strings = [];
  var cur = null, inT = 0, buf = '';
  await saxParseStream(f.stream(), {
    opentag: function(tag) {
      var ln = localName(tag.name);
      if      (ln === 'si') { cur = ''; }
      else if (ln === 't')  { inT++; buf = ''; }
    },
    text: function(t) { if (inT > 0) buf += t; },
    closetag: function(tag) {
      var ln = localName(tag.name);
      if      (ln === 't')  { inT--; cur = (cur || '') + buf; buf = ''; }
      else if (ln === 'si') { strings.push(cur || ''); cur = null; }
    }
  });
  return strings;
}

// styles.xml → boolean[] indexed by cell-style position: is style i a date format?
async function parseStyles(directory) {
  var xml = await readEntryText(directory, 'xl/styles.xml');
  if (!xml) return [];

  var numFmtCode = {};       // custom numFmtId → formatCode
  var cellXfNumFmtIds = [];  // cellXfs xf index → numFmtId
  var inCellXfs = false;

  saxParseString(xml, {
    opentag: function(tag) {
      var ln = localName(tag.name);
      if (ln === 'numFmt') {
        var id = parseInt(attr(tag.attributes, 'numFmtId'), 10);
        if (!Number.isNaN(id)) numFmtCode[id] = attr(tag.attributes, 'formatCode');
      } else if (ln === 'cellXfs') {
        inCellXfs = true;
      } else if (ln === 'xf' && inCellXfs) {
        var xid = parseInt(attr(tag.attributes, 'numFmtId') || '0', 10);
        cellXfNumFmtIds.push(Number.isNaN(xid) ? 0 : xid);
      }
    },
    closetag: function(tag) {
      if (localName(tag.name) === 'cellXfs') inCellXfs = false;
    }
  });

  return cellXfNumFmtIds.map(function(id) { return isDateNumFmt(id, numFmtCode[id]); });
}

// List sheet names in document order — for a "pick a sheet" UI step, before
// committing to streaming any one sheet's rows. Cheap: only reads
// workbook.xml, not any worksheet part.
async function list_xlsx_sheets(filePath) {
  var directory = await unzipper.Open.file(filePath);
  var wbXml = await readEntryText(directory, 'xl/workbook.xml');
  return parseWorkbookSheets(wbXml).map(function(s) { return s.name; });
}

// ── main API ─────────────────────────────────────────────────────────────
async function stream_xlsx_sheet_rows(filePath, sheet_name, handlers) {
  handlers = handlers || {};
  var onHeaders = handlers.onHeaders;
  var onRow     = handlers.onRow;
  var logFn     = handlers.logFunction || function() {};

  var directory = await unzipper.Open.file(filePath);

  var wbXml   = await readEntryText(directory, 'xl/workbook.xml');
  var relsXml = await readEntryText(directory, 'xl/_rels/workbook.xml.rels');
  var target  = resolveTargetPart(parseWorkbookSheets(wbXml), parseRels(relsXml), sheet_name, directory);
  if (!target || !target.part || !findFile(directory, target.part)) {
    throw new Error('xlsx-stream: could not resolve worksheet part for sheet "' + (sheet_name || '(first)') + '"');
  }
  logFn('xlsx-stream: reading "' + (target.name || sheet_name) + '" from ' + target.part);

  var sharedStrings = await parseSharedStrings(directory);
  var dateStyle     = await parseStyles(directory);
  var date1904      = /date1904\s*=\s*"?(1|true)"?/i.test(wbXml || '');

  var headers = null;
  var headerByCol = {};
  var row_count = 0;
  var dateColIdx = new Set();

  // per-cell SAX state
  var rowCells = {};
  var curCol = -1, curType = null, curStyle = 0, capturing = false, textBuf = '';

  function commitCellText(closingLocal) {
    var val;
    if (curType === 's') {
      var idx = parseInt(textBuf, 10);
      val = (sharedStrings && sharedStrings[idx] != null) ? sharedStrings[idx] : null;
    } else if (curType === 'b') {
      val = textBuf === '1';
    } else if (curType === 'str' || curType === 'inlineStr' || closingLocal === 't') {
      val = textBuf;
    } else {
      var n = Number(textBuf);
      val = (textBuf !== '' && !Number.isNaN(n)) ? n : (textBuf === '' ? null : textBuf);
      if (typeof val === 'number' && dateStyle[curStyle]) {
        val = excelSerialToDate(val, date1904);
        if (curCol >= 0) dateColIdx.add(curCol);
      }
    }
    if (curCol >= 0) rowCells[curCol] = val;
  }

  await saxParseStream(findFile(directory, target.part).stream(), {
    opentag: function(tag) {
      var ln = localName(tag.name);
      if (ln === 'row') { rowCells = {}; }
      else if (ln === 'c') {
        var ref = attr(tag.attributes, 'r');
        curCol   = ref ? colRefToIndex(ref) : (curCol + 1);
        curType  = attr(tag.attributes, 't') || null;
        var s    = attr(tag.attributes, 's');
        curStyle = s != null ? parseInt(s, 10) || 0 : 0;
      }
      else if (ln === 'v' || ln === 't') { capturing = true; textBuf = ''; }
    },
    text: function(t) { if (capturing) textBuf += t; },
    closetag: function(tag) {
      var ln = localName(tag.name);
      if (ln === 'v' || ln === 't') { commitCellText(ln); capturing = false; textBuf = ''; }
      else if (ln === 'row') {
        if (!headers) {
          headers = [];
          var cols = Object.keys(rowCells).map(Number);
          var maxCol = cols.length ? Math.max.apply(null, cols) : -1;
          for (var i = 0; i <= maxCol; i++) {
            var h = String(rowCells[i] == null ? '' : rowCells[i]).trim();
            headers.push(h);
            headerByCol[i] = h;
          }
          if (typeof onHeaders === 'function') onHeaders(headers);
        } else {
          var rec = {};
          for (var j = 0; j < headers.length; j++) {
            var hk = headerByCol[j];
            if (hk) rec[hk] = (rowCells[j] === undefined ? null : rowCells[j]);
          }
          if (typeof onRow === 'function') onRow(rec);
          row_count++;
        }
      }
    }
  });

  var date_columns = Array.from(dateColIdx).map(function(i) { return headerByCol[i]; }).filter(Boolean);

  return {
    sheet_name:   sheet_name || target.name || '(first sheet)',
    headers:      headers || [],
    row_count:    row_count,
    part:         target.part,
    date_columns: date_columns
  };
}

module.exports = { stream_xlsx_sheet_rows: stream_xlsx_sheet_rows, list_xlsx_sheets: list_xlsx_sheets };
