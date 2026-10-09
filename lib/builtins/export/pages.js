// export-pages — placed blocks to a PDF: a dashboard as it looked.
//
// Each page is a list of blocks positioned by FRACTIONS of the page's content
// box (x, w across; y, h down), so a layout drawn on any screen keeps its
// proportions on paper. A block is text, a small table, an image (a PNG or
// JPEG data URL — a chart is captured as one), a rectangle or a line. See
// lib/formats/writers/pdf.js renderPages for each block's fields.
//
// Bounded on purpose: what arrives here was posted by a browser, so the page,
// block and image counts and sizes are capped and an image must be a data URL
// of a raster type — no fetching, no markup.

var fs = require('fs');
var os = require('os');
var path = require('path');
var pdf = require('../../formats/writers/pdf');
var { checkFormatRequires } = require('../../formats');

var LIMITS = { pages: 50, blocksPerPage: 200, imageBytes: 8 * 1024 * 1024, tableRows: 500, text: 5000 };
var TYPES = ['text', 'table', 'image', 'rect', 'line'];

function fail(message) {
  var err = new Error(message);
  err.status = 400;
  return err;
}

function fraction(n) { return typeof n === 'number' && isFinite(n) && n >= -0.01 && n <= 50; }

/** Throws (400) naming the first block that is not one this action draws. */
function validate(spec) {
  var pages = spec.pages;
  if (!Array.isArray(pages) || !pages.length) throw fail('pages must list at least one page');
  if (pages.length > LIMITS.pages) throw fail('At most ' + LIMITS.pages + ' pages');
  pages.forEach(function(page, p) {
    var blocks = (page && page.blocks) || [];
    if (!Array.isArray(blocks)) throw fail('pages[' + p + '].blocks must be a list');
    if (blocks.length > LIMITS.blocksPerPage) throw fail('At most ' + LIMITS.blocksPerPage + ' blocks on a page');
    blocks.forEach(function(b, i) {
      var where = 'pages[' + p + '].blocks[' + i + ']';
      if (!b || TYPES.indexOf(b.type) === -1) throw fail(where + ': type must be one of ' + TYPES.join(', '));
      if (![b.x, b.y, b.w, b.h].every(fraction)) throw fail(where + ': x, y, w and h are fractions of the page');
      if (b.type === 'image') {
        var src = String(b.src || '');
        if (!/^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/.test(src)) throw fail(where + ': src must be a PNG or JPEG data URL');
        if (src.length * 0.75 > LIMITS.imageBytes) throw fail(where + ': image is larger than ' + (LIMITS.imageBytes >> 20) + ' MB');
      }
      if (b.type === 'table') {
        if (!Array.isArray(b.columns) || !Array.isArray(b.rows)) throw fail(where + ': a table needs columns and rows');
        if (b.rows.length > LIMITS.tableRows) b.rows = b.rows.slice(0, LIMITS.tableRows);
      }
      if (b.type === 'text' && String(b.text == null ? '' : b.text).length > LIMITS.text) b.text = String(b.text).slice(0, LIMITS.text);
    });
  });
}

module.exports = {
  name: 'export-pages',
  description: 'Lay out pages of placed blocks (text, tables, images, shapes) as a PDF — a dashboard as it looked.',
  requires: [],
  LIMITS: LIMITS,

  inputSchema: [
    { name: 'pages', type: 'array', required: true, order: 1,
      description: '[{ blocks: [{ type: text|table|image|rect|line, x, y, w, h, … }] }], positions as fractions of the page.' },
    { name: 'title', type: 'string', order: 2 },
    { name: 'footer', type: 'string', order: 3 },
    { name: 'landscape', type: 'boolean', order: 4, description: 'Default true.' },
    { name: 'outputPath', type: 'string', order: 5 }
  ],
  outputSchema: [
    { name: 'filePath', type: 'string' }, { name: 'fileName', type: 'string' },
    { name: 'contentType', type: 'string' }, { name: 'bytes', type: 'number' }, { name: 'pages', type: 'number' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    checkFormatRequires('export-pages', 'pdf', pdf);
    validate(input);
    var name = (String(input.title || 'dashboard').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').trim().slice(0, 80) || 'dashboard') + '.pdf';
    var dir = process.env.XEPLR_ACTIONS_TMP_DIR || path.join(os.tmpdir(), 'xeplr-actions');
    fs.mkdirSync(dir, { recursive: true });
    var filePath = input.outputPath || path.join(fs.mkdtempSync(path.join(dir, 'export-')), name);
    var done = await pdf.renderPages(filePath, {
      pages: input.pages, title: input.title, footer: input.footer, landscape: input.landscape !== false
    });
    return {
      filePath: filePath, fileName: path.basename(filePath), contentType: 'application/pdf',
      bytes: fs.statSync(filePath).size, pages: done.pages
    };
  }
};
