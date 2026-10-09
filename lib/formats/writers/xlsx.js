// .xlsx writer — our own, on fflate's streaming zip.
//
// Why not exceljs: it pulls a uuid with a published advisory, has not had a
// release since December 2024, and the override that silences it has to be
// repeated in every app that installs this package. Writing SpreadsheetML is
// the other half of what lib/formats/_xlsx-stream.js already reads, and a
// workbook of one styled sheet is a small, well-specified thing.
//
// WHAT IT WRITES: one sheet; an optional title and subtitle above the header;
// the header bold on a tint, frozen, with an autofilter; numbers and dates as
// REAL cells carrying their number format, so the reader can still sum and
// filter; subtotal rows bold, total rows bold on a tint; column widths from
// the header and the first rows.
//
// Streaming: rows go straight into the zip, which goes straight to disk,
// waiting on the file stream when it is full — a million rows costs the
// same memory as a hundred. Only the first SAMPLE_ROWS are held, to size the
// columns, because <cols> must come before the rows in the sheet.

var fs = require('fs');

var MAX_ROWS = 1048576;          // Excel's own limit, header and title rows included
var SAMPLE_ROWS = 200;
var CHUNK = 1 << 20;             // push to the zip in ~1 MB pieces

// XML 1.0 cannot carry most control characters even escaped; Excel refuses
// the file ("We found a problem with some content"). Dropped.
var INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
function esc(value) {
  return String(value).replace(INVALID_XML, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 0 → A, 25 → Z, 26 → AA. */
function colName(i) {
  var s = '';
  for (var n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** A Date, or an ISO date string, as an Excel serial — or null. */
function dateSerial(value) {
  var d = value instanceof Date ? value : (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? new Date(value) : null);
  if (!d || isNaN(d.getTime())) return null;
  return d.getTime() / 86400000 + 25569;
}

// Fonts: 0 normal, 1 bold, 2 title. Fills: 0 none, 1 gray125 (both required
// by Excel at those positions), 2 header tint, 3 total tint.
var FONT = { normal: 0, bold: 1, title: 2 };
var FILL = { none: 0, header: 2, total: 3 };

function stylesXml(numFmts, xfs) {
  var fmts = numFmts.map(function(code, i) { return '<numFmt numFmtId="' + (164 + i) + '" formatCode="' + esc(code) + '"/>'; });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    (fmts.length ? '<numFmts count="' + fmts.length + '">' + fmts.join('') + '</numFmts>' : '') +
    '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="14"/><name val="Calibri"/></font></fonts>' +
    '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F3F7"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EBF2"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left/><right/><top style="thin"><color rgb="FF9AA1AE"/></top><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' + xfs.length + '">' + xfs.map(function(x) {
      return '<xf numFmtId="' + x.numFmtId + '" fontId="' + x.fontId + '" fillId="' + x.fillId + '" borderId="' + x.borderId + '" xfId="0"' +
        (x.numFmtId ? ' applyNumberFormat="1"' : '') + (x.fontId ? ' applyFont="1"' : '') + (x.fillId ? ' applyFill="1"' : '') +
        (x.borderId ? ' applyBorder="1"' : '') + (x.align ? ' applyAlignment="1"><alignment horizontal="' + x.align + '"/></xf>' : '/>');
    }).join('') + '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

var STATIC = {
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>',
  'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>'
};

function workbookXml(sheetName, filterRef) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="' + esc(sheetName) + '" sheetId="1" r:id="rId1"/></sheets>' +
    (filterRef ? '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">' + esc("'" + sheetName.replace(/'/g, "''") + "'!" + filterRef) + '</definedName></definedNames>' : '') +
    '</workbook>';
}

/** Excel refuses a sheet name over 31 characters or with any of : \ / ? * [ ] */
function sheetNameOf(title) {
  var name = String(title || 'Sheet1').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31);
  return name || 'Sheet1';
}

module.exports = {
  requires: ['fflate'],
  MAX_ROWS: MAX_ROWS,

  /**
   * @param {string} filePath
   * @param {object} doc - { title?, subtitle?, columns: [{ header, kind?: 'number'|'date'|'text'|'raw', numFmt?, width?, align? }] }
   *   kind 'number': the value is written as a number (numFmt applies);
   *   kind 'date': a Date or ISO string, written as a date serial (numFmt applies);
   *   anything else: a number stays a number, everything else is text.
   * @returns {{ writeRow(row): Promise<boolean>, close(): Promise<{ rows, truncated }> }}
   *   row: { values: [], kind?: 'detail'|'subtotal'|'total' }. writeRow answers
   *   false once Excel's row limit is reached (the rest are counted, not written).
   */
  open: function(filePath, doc) {
    var fflate = require('fflate');
    var columns = doc.columns || [];
    var out = fs.createWriteStream(filePath);
    var failed = null;
    out.on('error', function(err) { failed = err; });
    var zipDone;
    var zipFinished = new Promise(function(resolve) { zipDone = resolve; });
    var zip = new fflate.Zip(function(err, chunk, final) {
      if (err) { failed = err; return; }
      out.write(Buffer.from(chunk));
      if (final) zipDone();
    });
    function addFile(name, text) {
      var f = new fflate.ZipDeflate(name, { level: 6 });
      zip.add(f);
      f.push(fflate.strToU8(text), true);
    }

    // Styles are collected as the rows use them and written at the end.
    var numFmts = [];
    var xfs = [{ numFmtId: 0, fontId: 0, fillId: 0, borderId: 0 }];
    var xfIndex = { '0|0|0|0|': 0 };
    function styleId(numFmt, fontId, fillId, borderId, align) {
      var numFmtId = 0;
      if (numFmt) {
        var at = numFmts.indexOf(numFmt);
        if (at < 0) { numFmts.push(numFmt); at = numFmts.length - 1; }
        numFmtId = 164 + at;
      }
      var key = numFmtId + '|' + fontId + '|' + fillId + '|' + borderId + '|' + (align || '');
      if (xfIndex[key] === undefined) {
        xfs.push({ numFmtId: numFmtId, fontId: fontId, fillId: fillId, borderId: borderId, align: align || null });
        xfIndex[key] = xfs.length - 1;
      }
      return xfIndex[key];
    }
    var LOOK = {
      detail: { font: FONT.normal, fill: FILL.none, border: 0 },
      subtotal: { font: FONT.bold, fill: FILL.none, border: 0 },
      total: { font: FONT.bold, fill: FILL.total, border: 1 }
    };

    var sheet = new fflate.ZipDeflate('xl/worksheets/sheet1.xml', { level: 6 });
    var buffered = '';
    var rowNo = 0;
    var written = 0;     // data rows written
    var offered = 0;     // data rows asked for
    var headerRow = 0;
    var sample = [];
    var started = false;

    function cellXml(ref, value, column, look) {
      if (value === null || value === undefined || value === '') return '';
      var kind = column.kind;
      var align = column.align === 'right' || column.align === 'center' ? column.align : null;
      if (kind === 'date') {
        var serial = dateSerial(value);
        if (serial !== null) return '<c r="' + ref + '" s="' + styleId(column.numFmt || 'yyyy-mm-dd', look.font, look.fill, look.border, align) + '"><v>' + serial + '</v></c>';
      }
      var num = typeof value === 'number' ? value : (kind === 'number' && value !== '' && !isNaN(Number(value)) ? Number(value) : null);
      if (num !== null && isFinite(num)) {
        return '<c r="' + ref + '" s="' + styleId(kind === 'number' ? column.numFmt : null, look.font, look.fill, look.border, align) + '"><v>' + num + '</v></c>';
      }
      if (typeof value === 'boolean') return '<c r="' + ref + '" t="b" s="' + styleId(null, look.font, look.fill, look.border, align) + '"><v>' + (value ? 1 : 0) + '</v></c>';
      return '<c r="' + ref + '" t="inlineStr" s="' + styleId(null, look.font, look.fill, look.border, align) + '"><is><t xml:space="preserve">' + esc(value) + '</t></is></c>';
    }

    function textRow(cells) { rowNo += 1; return '<row r="' + rowNo + '">' + cells + '</row>'; }

    async function push(text, final) {
      buffered += text;
      if (buffered.length < CHUNK && !final) return;
      sheet.push(fflate.strToU8(buffered), Boolean(final));
      buffered = '';
      if (failed) throw failed;
      if (out.writableNeedDrain) await new Promise(function(r) { out.once('drain', r); });
    }

    // <cols> needs the widths, which need a look at the rows: written once
    // the sample is full, or at close for a short table.
    async function start() {
      started = true;
      var widths = columns.map(function(c, i) {
        if (c.width) return c.width;
        var longest = String(c.header || '').length;
        // A date is as wide as its pattern, not as its JS string form.
        if (c.kind === 'date') return Math.min(60, Math.max(10, longest, String(c.numFmt || 'yyyy-mm-dd').length) + 2);
        sample.forEach(function(r) {
          var shown = r.display ? r.display[i] : r.values[i];
          if (shown !== null && shown !== undefined) longest = Math.max(longest, String(shown).length);
        });
        return Math.min(60, Math.max(8, longest + 2));
      });
      zip.add(sheet);
      var head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
      var titleRows = (doc.title ? 1 : 0) + (doc.subtitle ? 1 : 0);
      headerRow = titleRows + (titleRows ? 2 : 1);
      head += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="' + headerRow + '" topLeftCell="A' + (headerRow + 1) +
        '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
      head += '<cols>' + widths.map(function(w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols>';
      head += '<sheetData>';
      if (doc.title) head += textRow('<c r="A' + (rowNo + 1) + '" t="inlineStr" s="' + styleId(null, FONT.title, 0, 0) + '"><is><t xml:space="preserve">' + esc(doc.title) + '</t></is></c>');
      if (doc.subtitle) head += textRow('<c r="A' + (rowNo + 1) + '" t="inlineStr"><is><t xml:space="preserve">' + esc(doc.subtitle) + '</t></is></c>');
      if (titleRows) rowNo += 1; // a blank row between the title block and the table
      head += textRow(columns.map(function(c, i) {
        var align = c.align === 'right' || c.align === 'center' ? c.align : null;
        return '<c r="' + colName(i) + (rowNo + 1) + '" t="inlineStr" s="' + styleId(null, FONT.bold, FILL.header, 0, align) + '"><is><t xml:space="preserve">' + esc(c.header == null ? '' : c.header) + '</t></is></c>';
      }).join(''));
      await push(head);
      var held = sample;
      sample = null;
      for (var k = 0; k < held.length; k++) await emit(held[k]);
    }

    async function emit(row) {
      if (rowNo >= MAX_ROWS) return false;
      var look = LOOK[row.kind] || LOOK.detail;
      var r = rowNo + 1;
      var cells = '';
      var values = row.values || [];
      for (var i = 0; i < columns.length; i++) cells += cellXml(colName(i) + r, values[i], columns[i], look);
      written += 1;
      await push(textRow(cells));
      return true;
    }

    return {
      writeRow: async function(row) {
        offered += 1;
        if (!started) {
          sample.push(row);
          if (sample.length >= SAMPLE_ROWS) await start();
          return true;
        }
        return emit(row);
      },
      close: async function() {
        if (!started) await start();
        var lastRow = Math.max(rowNo, headerRow);
        var filterRef = columns.length ? 'A' + headerRow + ':' + colName(columns.length - 1) + lastRow : null;
        await push('</sheetData>' + (filterRef ? '<autoFilter ref="' + filterRef + '"/>' : '') +
          '<pageSetup orientation="' + (columns.length > 6 ? 'landscape' : 'portrait') + '"/></worksheet>', true);
        var sheetName = sheetNameOf(doc.title);
        Object.keys(STATIC).forEach(function(name) { addFile(name, STATIC[name]); });
        addFile('xl/workbook.xml', workbookXml(sheetName, filterRef ? '$A$' + headerRow + ':$' + colName(columns.length - 1) + '$' + lastRow : null));
        addFile('xl/styles.xml', stylesXml(numFmts, xfs));
        zip.end();
        await zipFinished;
        await new Promise(function(resolve, reject) { out.end(function(err) { return err ? reject(err) : resolve(); }); });
        if (failed) throw failed;
        return { rows: written, truncated: offered > written };
      }
    };
  }
};
