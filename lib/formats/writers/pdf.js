// PDF writer, on pdfkit — a table as the reader saw it, or a page of placed
// blocks (a dashboard as it looked).
//
// Text is drawn from each cell's DISPLAY string: a PDF is for reading, so it
// shows exactly what the screen did ("₹1,234.50", "Jan 2024"), not the raw
// value. Numbers are right-aligned by the column's own `align`.
//
// FONT: pdfkit's built-in fonts are WinAnsi only — no "₹", no Devanagari, no
// CJK — and a missing glyph draws as nothing at all. DejaVu Sans Condensed
// (the `dejavu-fonts-ttf` peer) covers Latin, Greek, Cyrillic, the currency
// signs and box drawing, and is narrow enough for a table. Pass `font` /
// `boldFont` (paths to TTF/OTF) for scripts it lacks. Only the glyphs used
// are embedded, so the file stays small.

var fs = require('fs');
var path = require('path');

var MAX_TABLE_ROWS = 5000;
var COLORS = { text: '#1c2029', muted: '#6b7280', headerFill: '#f1f3f7', totalFill: '#e8ebf2', rule: '#9aa1ae', grid: '#e2e5eb' };

function fontPaths(opts) {
  if (opts.font) return { body: opts.font, bold: opts.boldFont || opts.font };
  var dir = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
  return { body: path.join(dir, 'DejaVuSansCondensed.ttf'), bold: path.join(dir, 'DejaVuSansCondensed-Bold.ttf') };
}

function newDocument(filePath, opts) {
  var PDFDocument = require('pdfkit');
  var doc = new PDFDocument({
    size: opts.size || 'A4',
    layout: opts.landscape ? 'landscape' : 'portrait',
    margins: { top: 36, bottom: 36, left: 32, right: 32 },
    bufferPages: true,
    info: { Title: opts.title || 'Export', Producer: '@xeplr/actions' }
  });
  var fonts = fontPaths(opts);
  doc.registerFont('body', fonts.body);
  doc.registerFont('bold', fonts.bold);
  doc.font('body');
  var out = fs.createWriteStream(filePath);
  var finished = new Promise(function(resolve, reject) { out.on('finish', resolve); out.on('error', reject); doc.on('error', reject); });
  // Observed now, awaited later: a render that throws part-way never awaits
  // it, and its rejection must not surface as an unhandled one.
  finished.catch(function() {});
  doc.pipe(out);
  return {
    doc: doc,
    finished: finished,
    /** A render that failed: close the stream and leave no half a file. */
    abandon: function() {
      try { doc.unpipe(out); } catch (e) { /* not piped */ }
      out.destroy();
      try { fs.rmSync(filePath, { force: true }); } catch (e) { /* already gone */ }
    }
  };
}

/** "Page 3 of 12" on every page, written once the page count is known. */
function stampPages(doc, footer) {
  var range = doc.bufferedPageRange();
  for (var i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    var bottom = doc.page.height - 24;
    // A footer drawn below the bottom margin would otherwise open a new page.
    var saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('body').fontSize(7.5).fillColor(COLORS.muted);
    if (footer) doc.text(footer, doc.page.margins.left, bottom, { lineBreak: false });
    doc.text('Page ' + (i - range.start + 1) + ' of ' + range.count, doc.page.margins.left, bottom,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'right', lineBreak: false });
    doc.page.margins.bottom = saved;
  }
}

/**
 * Column widths for a table drawn `width` points wide: each column as wide as
 * its header and its widest sampled value, then scaled to fill the width —
 * shrinking the font first when the natural widths do not fit, so a wide
 * table still reads rather than truncating every cell.
 */
function layoutColumns(doc, columns, sampleRows, width, baseSize) {
  var size = baseSize;
  var natural;
  for (;;) {
    natural = columns.map(function(c, i) {
      doc.font('bold').fontSize(size);
      var w = doc.widthOfString(String(c.header == null ? '' : c.header));
      doc.font('body').fontSize(size);
      sampleRows.forEach(function(r) {
        var t = cellText(r, i);
        if (t) w = Math.max(w, doc.widthOfString(t));
      });
      return Math.min(w, width * 0.45) + size * 1.2;
    });
    var total = natural.reduce(function(a, b) { return a + b; }, 0);
    if (total <= width || size <= 6) break;
    size = Math.max(6, size - 0.5);
  }
  var sum = natural.reduce(function(a, b) { return a + b; }, 0) || 1;
  return { size: size, widths: natural.map(function(w) { return w * width / sum; }) };
}

function cellText(row, i) {
  var v = row.display ? row.display[i] : (row.values || [])[i];
  return v === null || v === undefined ? '' : String(v);
}

/**
 * Draws a header and rows into a box. Paged: when `paged`, a row that would
 * cross the bottom opens a new page and repeats the header; otherwise rows
 * stop at the box and the rest are counted.
 * @returns {{ drawn, hidden }}
 */
function drawTable(doc, box, columns, rows, opts) {
  var layout = layoutColumns(doc, columns, rows.slice(0, 300), box.w, opts.fontSize || 8.5);
  var size = layout.size;
  var rowH = size * 1.95;
  var pad = size * 0.6;
  var y = box.y;
  var bottom = box.y + box.h;

  function drawRow(cells, look) {
    var x = box.x;
    if (look.fill) doc.rect(box.x, y, box.w, rowH).fill(look.fill);
    if (look.rule) doc.moveTo(box.x, y).lineTo(box.x + box.w, y).lineWidth(0.8).strokeColor(COLORS.rule).stroke();
    doc.font(look.bold ? 'bold' : 'body').fontSize(size).fillColor(COLORS.text);
    for (var i = 0; i < columns.length; i++) {
      var w = layout.widths[i];
      var align = columns[i].align === 'right' || columns[i].align === 'center' ? columns[i].align : 'left';
      doc.text(cells[i], x + pad / 2, y + (rowH - size) / 2 - 1, { width: Math.max(1, w - pad), align: align, lineBreak: false, ellipsis: true, height: rowH });
      x += w;
    }
    if (!look.fill && !look.rule) doc.moveTo(box.x, y + rowH).lineTo(box.x + box.w, y + rowH).lineWidth(0.4).strokeColor(COLORS.grid).stroke();
    y += rowH;
  }
  function header() {
    drawRow(columns.map(function(c) { return c.header == null ? '' : String(c.header); }), { bold: true, fill: COLORS.headerFill });
  }

  header();
  var drawn = 0;
  for (var r = 0; r < rows.length; r++) {
    if (y + rowH > bottom) {
      if (!opts.paged) break;
      doc.addPage();
      y = doc.page.margins.top;
      bottom = doc.page.height - doc.page.margins.bottom - 14;
      header();
    }
    var kind = rows[r].kind;
    drawRow(columns.map(function(c, i) { return cellText(rows[r], i); }),
      kind === 'total' ? { bold: true, fill: COLORS.totalFill, rule: true } : kind === 'subtotal' ? { bold: true } : {});
    drawn += 1;
  }
  return { drawn: drawn, hidden: rows.length - drawn, endY: y };
}

module.exports = {
  requires: ['pdfkit', 'dejavu-fonts-ttf'],
  MAX_TABLE_ROWS: MAX_TABLE_ROWS,

  /**
   * A table, paged. Rows are held until close (pdfkit lays out page by page,
   * and the column widths need a look at the rows), so the row cap matters:
   * a PDF is for reading, and 5,000 rows is already a hundred pages.
   *
   * @param {object} doc - { title?, subtitle?, footer?, columns: [{ header, align? }], maxRows?, font?, boldFont? }
   */
  open: function(filePath, doc) {
    var columns = doc.columns || [];
    var cap = doc.maxRows || MAX_TABLE_ROWS;
    var rows = [];
    var offered = 0;
    return {
      writeRow: async function(row) {
        offered += 1;
        if (rows.length >= cap) return false;
        rows.push(row);
        return true;
      },
      close: async function() {
        var made = newDocument(filePath, { title: doc.title, landscape: columns.length > 6, font: doc.font, boldFont: doc.boldFont });
        var pdf = made.doc;
        try {
        var left = pdf.page.margins.left;
        var width = pdf.page.width - left - pdf.page.margins.right;
        var y = pdf.page.margins.top;
        if (doc.title) { pdf.font('bold').fontSize(14).fillColor(COLORS.text).text(doc.title, left, y, { width: width }); y = pdf.y + 2; }
        if (doc.subtitle) { pdf.font('body').fontSize(8.5).fillColor(COLORS.muted).text(doc.subtitle, left, y, { width: width }); y = pdf.y; }
        if (doc.title || doc.subtitle) y += 8;
        var result = drawTable(pdf, { x: left, y: y, w: width, h: pdf.page.height - pdf.page.margins.bottom - 14 - y }, columns, rows, { paged: true });
        if (offered > rows.length) {
          var noteY = result.endY + 6;
          if (noteY + 12 > pdf.page.height - pdf.page.margins.bottom - 14) { pdf.addPage(); noteY = pdf.page.margins.top; }
          pdf.font('body').fontSize(8).fillColor(COLORS.muted).text('Showing the first ' + rows.length.toLocaleString('en-US') + ' of ' +
            offered.toLocaleString('en-US') + ' rows. Export to Excel or CSV for all of them.', left, noteY, { width: width });
        }
        stampPages(pdf, doc.footer);
        } catch (err) {
          made.abandon();
          throw err;
        }
        pdf.end();
        await made.finished;
        return { rows: rows.length, truncated: offered > rows.length };
      }
    };
  },

  /**
   * Pages of placed blocks — a dashboard as it looked. Every position is a
   * FRACTION of the page's content box, so the layout keeps its proportions
   * on any paper size.
   *
   * blocks:
   *   { type: 'text', x, y, w, h, text, size? | sizeRel?, bold?, color?, align? }  — sizeRel: a fraction of the page width
   *   { type: 'table', x, y, w, h, title?, columns, rows }  — no paging; rows past the box are counted
   *   { type: 'image', x, y, w, h, src }                     — a data: URL, PNG or JPEG only
   *   { type: 'rect', x, y, w, h, fill?, stroke?, strokeWidth?, radius? }
   *   { type: 'line', x, y, w, h, stroke?, strokeWidth? }    — from (x,y) to (x+w,y+h)
   *
   * @param {object} spec - { pages: [{ blocks }], title?, footer?, landscape?: true, font?, boldFont? }
   */
  renderPages: async function(filePath, spec) {
    var made = newDocument(filePath, { title: spec.title, landscape: spec.landscape !== false, font: spec.font, boldFont: spec.boldFont });
    var pdf = made.doc;
    var pages = spec.pages && spec.pages.length ? spec.pages : [{ blocks: [] }];
    try {
    var counts = { blocks: 0, hiddenRows: 0, badImages: 0 };
    pages.forEach(function(page, p) {
      if (p > 0) pdf.addPage();
      var m = pdf.page.margins;
      var box = { x: m.left, y: m.top, w: pdf.page.width - m.left - m.right, h: pdf.page.height - m.top - m.bottom - 14 };
      if (p === 0 && spec.title) {
        pdf.font('bold').fontSize(13).fillColor(COLORS.text).text(spec.title, box.x, box.y, { width: box.w, lineBreak: false });
        var used = pdf.y - box.y + 6;
        box = { x: box.x, y: box.y + used, w: box.w, h: box.h - used };
      }
      (page.blocks || []).forEach(function(b) {
        counts.blocks += 1;
        var at = { x: box.x + b.x * box.w, y: box.y + b.y * box.h, w: b.w * box.w, h: b.h * box.h };
        pdf.save();
        pdf.rect(at.x, at.y, at.w, at.h).clip();
        if (b.type === 'rect') {
          var shape = b.radius ? pdf.roundedRect(at.x, at.y, at.w, at.h, b.radius) : pdf.rect(at.x, at.y, at.w, at.h);
          if (b.fill && b.stroke) shape.lineWidth(b.strokeWidth || 1).fillAndStroke(b.fill, b.stroke);
          else if (b.fill) shape.fill(b.fill);
          else if (b.stroke) shape.lineWidth(b.strokeWidth || 1).stroke(b.stroke);
        } else if (b.type === 'line') {
          pdf.restore(); pdf.save();   // a line is not clipped to its own (often zero-height) box
          pdf.moveTo(at.x, at.y).lineTo(at.x + at.w, at.y + at.h).lineWidth(b.strokeWidth || 1).strokeColor(b.stroke || COLORS.rule).stroke();
        } else if (b.type === 'image') {
          var match = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.src || ''));
          // One chart that would not capture must not sink the whole board:
          // its box says so and the rest is drawn.
          try {
            if (match) pdf.image(Buffer.from(match[2], 'base64'), at.x, at.y, { fit: [at.w, at.h], align: 'center', valign: 'center' });
          } catch (err) {
            counts.badImages += 1;
            pdf.font('body').fontSize(8).fillColor(COLORS.muted).text('This chart could not be drawn', at.x, at.y + at.h / 2 - 4, { width: at.w, align: 'center', lineBreak: false });
          }
        } else if (b.type === 'table') {
          var top = at.y;
          if (b.title) {
            pdf.font('bold').fontSize(9).fillColor(COLORS.text).text(b.title, at.x, at.y, { width: at.w, lineBreak: false, ellipsis: true });
            top = at.y + 14;
          }
          var drawn = drawTable(pdf, { x: at.x, y: top, w: at.w, h: at.y + at.h - top }, b.columns || [], b.rows || [], { paged: false, fontSize: 7.5 });
          counts.hiddenRows += drawn.hidden;
          if (drawn.hidden > 0) {
            pdf.font('body').fontSize(7).fillColor(COLORS.muted)
              .text('+' + drawn.hidden.toLocaleString('en-US') + ' more rows', at.x, at.y + at.h - 9, { width: at.w, align: 'right', lineBreak: false });
          }
        } else if (b.type === 'text') {
          // sizeRel: a fraction of the page width — how a screen's text keeps
          // its proportion on paper of another width.
          var size = b.sizeRel ? Math.max(5, Math.min(72, b.sizeRel * box.w)) : (b.size || 10);
          pdf.font(b.bold ? 'bold' : 'body').fontSize(size).fillColor(b.color || COLORS.text)
            .text(String(b.text == null ? '' : b.text), at.x, at.y, { width: at.w, height: at.h, align: b.align || 'left', ellipsis: true });
        }
        pdf.restore();
      });
    });
    stampPages(pdf, spec.footer);
    } catch (err) {
      made.abandon();
      throw err;
    }
    pdf.end();
    await made.finished;
    return { pages: pages.length, blocks: counts.blocks, hiddenRows: counts.hiddenRows, badImages: counts.badImages };
  }
};
