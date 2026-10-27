// file-list action — the files in a folder, optionally matching a pattern.
//
// Also the way to ask "is it there yet?": list with the exact name and branch
// on output.count. Only inside the folders file steps may use (lib/fileRoots.js).

var fs = require('fs');
var path = require('path');
var fileRoots = require('../../fileRoots');

/** `*.csv`, `Bank-2026-??.pdf` → a test on a name. Case-insensitive. */
function matcher(pattern) {
  if (!pattern) return function() { return true; };
  var re = new RegExp('^' + String(pattern).split('').map(function(ch) {
    if (ch === '*') return '.*';
    if (ch === '?') return '.';
    return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('') + '$', 'i');
  return function(name) { return re.test(name); };
}

module.exports = {
  name: 'file-list',
  description: 'The files in a folder, optionally matching a pattern such as *.csv. Returns { files[], count }. ' +
               'Ask "is it there?" with the exact name and branch on count.',
  requires: [],
  inputSchema: [
    { name: 'folder', type: 'string', required: true, order: 1,
      description: 'An absolute folder inside XEPLR_FILE_ROOTS, e.g. /data/bank.' },
    { name: 'pattern', type: 'string', order: 2,
      description: 'Only names matching this: * any characters, ? one. E.g. Bank-{trigger.window.from|date:YYYY-MM}*.csv' },
    { name: 'sort', type: 'string', default: 'name', options: ['name', 'newest', 'oldest'], order: 3,
      description: 'name: A to Z. newest / oldest: by when the file last changed.' }
  ],
  outputSchema: [
    { name: 'files', type: 'array', description: '[{ name, path, size, modifiedAt }]' },
    { name: 'count', type: 'number', description: 'How many, so the next step can branch on none.' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var dir = fileRoots.allowed(input.folder, 'The folder');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      var missing = new Error('"' + input.folder + '" is not a folder that exists.');
      missing.code = 'NOT_A_FOLDER';
      throw missing;
    }
    var test = matcher(input.pattern);
    var files = fs.readdirSync(dir, { withFileTypes: true })
      .filter(function(e) { return e.isFile() && test(e.name); })
      .map(function(e) {
        var full = path.join(dir, e.name);
        var st = fs.statSync(full);
        return { name: e.name, path: full, size: st.size, modifiedAt: st.mtime.toISOString() };
      });
    if (input.sort === 'newest') files.sort(function(a, b) { return b.modifiedAt.localeCompare(a.modifiedAt); });
    else if (input.sort === 'oldest') files.sort(function(a, b) { return a.modifiedAt.localeCompare(b.modifiedAt); });
    else files.sort(function(a, b) { return a.name.localeCompare(b.name); });
    return { files: files, count: files.length };
  }
};
