// export-pages with an exact page size — a PDF of the screen, written for
// real and read back: the page is the size asked for, the image fills it, and
// nothing else (no title, no footer, no page numbers) is drawn.
//
// At the top level of test/ so the pre-commit gate runs it.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var { runAction } = require('../lib/runner');
var actions = { runAction: runAction, builtins: { exportPages: require('../lib/builtins/export/pages') } };

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-exact-'));
var out = function(name) { return path.join(dir, name); };

test('export-pages: a page of an exact size, edge to edge, with nothing added', async function() {
  // A PDF of the screen: the board's own size in points, one image filling it.
  function chunk(type, data) {
    var len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    var body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    var crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  }
  var png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0])),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]))),
    chunk('IEND', Buffer.alloc(0))]).toString('base64');
  var res = await actions.runAction(actions.builtins.exportPages, {
    title: 'Board', footer: 'Date: July 2023', outputPath: out('exact.pdf'),
    page: { width: 1380, height: 1512.75 },
    pages: [{ blocks: [{ type: 'image', x: 0, y: 0, w: 1, h: 1, src: png }] }]
  });
  assert.strictEqual(res.status, 'success', res.error && res.error.message);
  var raw = fs.readFileSync(res.output.filePath, 'latin1');
  assert.match(raw, /\/MediaBox \[0 0 1380 1512\.75\]/, 'the page is exactly the size asked for');
  assert.match(raw, /\/Subtype \/Image/, 'the image is in the file');
  // Nothing drawn but the image: no title, no "Page 1 of 1", no footer.
  var texts = 0, re = /stream\r?\n/g, m;
  while ((m = re.exec(raw))) {
    var start = m.index + m[0].length;
    try { texts += (zlib.inflateSync(Buffer.from(raw.slice(start, raw.indexOf('endstream', start)), 'latin1')).toString('latin1').match(/\bT[Jj]\b/g) || []).length; } catch (e) { /* not a content stream */ }
  }
  assert.strictEqual(texts, 0, 'no text is added to an exact page');

  for (var bad of [{ width: 10, height: 500 }, { width: 500, height: 20000 }, { width: 'wide', height: 500 }, 'A4']) {
    var r = await actions.runAction(actions.builtins.exportPages, { page: bad, pages: [{ blocks: [] }], outputPath: out('bad.pdf') });
    assert.strictEqual(r.status, 'failed');
    assert.match(r.error.message, /page must be \{ width, height \} in points|"page" expected type object/);
  }
});

test.after(function() { fs.rmSync(dir, { recursive: true, force: true }); });
