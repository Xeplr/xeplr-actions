// file-delete action — remove one file.
//
// A file a workflow has finished with: the bank file read and posted, so the
// next check of the folder does not find it again. PERMANENT — there is no
// trash to take it back from; file-move into a "processed" folder is the one
// that can be undone. Only inside the folders file steps may use
// (lib/fileRoots.js), and only a file, never a folder.

var fs = require('fs');
var fileRoots = require('../../fileRoots');

module.exports = {
  name: 'file-delete',
  description: 'Delete one file, permanently (file-move to a "processed" folder is the reversible one). Returns { path, deleted, skipped }.',
  requires: [],
  inputSchema: [
    { name: 'path', type: 'string', required: true, order: 1,
      description: 'The file, by absolute path, e.g. {item.path}.' },
    { name: 'ifMissing', type: 'string', default: 'fail', options: ['fail', 'skip'], order: 2,
      description: 'When there is no such file. fail: the step fails. skip: it goes on, deleted false.' }
  ],
  outputSchema: [
    { name: 'path', type: 'string' }, { name: 'deleted', type: 'boolean' }, { name: 'skipped', type: 'boolean' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var file = fileRoots.allowed(input.path, 'The file to delete');
    if (!fs.existsSync(file)) {
      if (input.ifMissing === 'skip') return { path: file, deleted: false, skipped: true };
      var missing = new Error('"' + input.path + '" is not a file that exists.');
      missing.code = 'FILE_NOT_FOUND';
      throw missing;
    }
    if (!fs.statSync(file).isFile()) {
      var folder = new Error('"' + input.path + '" is a folder; file-delete removes one file.');
      folder.code = 'NOT_A_FILE';
      throw folder;
    }
    fs.unlinkSync(file);
    return { path: file, deleted: true, skipped: false };
  }
};
