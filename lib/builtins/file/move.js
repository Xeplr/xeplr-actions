// file-move action — move or copy a file, into a folder or to a new name.
//
// "Processed" folders, an archive by month, a copy for another team. Only
// inside the folders file steps may use (lib/fileRoots.js), at both ends. A
// name already taken at the target follows the rule every file-writing step
// follows (lib/fileNames.js): fail by default.

var fs = require('fs');
var path = require('path');
var fileRoots = require('../../fileRoots');
var fileNames = require('../../fileNames');

module.exports = {
  name: 'file-move',
  description: 'Move or copy a file into a folder, or to a new name. Returns { path, name, moved, skipped }.',
  requires: [],
  inputSchema: [
    { name: 'from', type: 'string', required: true, order: 1,
      description: 'The file, by absolute path, e.g. {steps.save.output.path}.' },
    { name: 'to', type: 'string', required: true, order: 2,
      description: 'A folder (it keeps its name), or a full path to rename it, e.g. /data/archive/{trigger.window.from|date:YYYY-MM}/' },
    { name: 'operation', type: 'string', default: 'move', options: ['move', 'copy'], order: 3,
      description: 'move: it is no longer where it was. copy: it is in both places.' },
    { name: 'ifExists', type: 'string', default: 'fail', options: fileNames.IF_EXISTS, order: 4,
      description: 'When the target name is taken. fail: the step fails and nothing moves. skip: left where it is. ' +
                   'overwrite: replaced. addSuffix: "name (2).ext".' }
  ],
  outputSchema: [
    { name: 'path', type: 'string' }, { name: 'name', type: 'string' },
    { name: 'moved', type: 'boolean' }, { name: 'skipped', type: 'boolean' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var from = fileRoots.allowed(input.from, 'The file to move');
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) {
      var missing = new Error('"' + input.from + '" is not a file that exists.');
      missing.code = 'FILE_NOT_FOUND';
      throw missing;
    }
    // A folder: ends with a separator, or is one already.
    var toIsFolder = /[\/\\]$/.test(input.to) || (fs.existsSync(input.to) && fs.statSync(input.to).isDirectory());
    var dir = fileRoots.allowed(toIsFolder ? input.to : path.dirname(input.to), 'The target folder');
    fs.mkdirSync(dir, { recursive: true });
    var wanted = toIsFolder ? path.basename(from) : fileNames.safeName(path.basename(input.to));
    var place = fileNames.plan(dir, [wanted], input.ifExists)[0];
    if (!place.write) return { path: place.path, name: place.name, moved: false, skipped: true };

    if (input.operation === 'copy') {
      fs.copyFileSync(from, place.path);
    } else {
      try {
        fs.renameSync(from, place.path);
      } catch (err) {
        // Another disk: copy, then remove.
        if (err.code !== 'EXDEV') throw err;
        fs.copyFileSync(from, place.path);
        fs.unlinkSync(from);
      }
    }
    return { path: place.path, name: place.name, moved: input.operation !== 'copy', skipped: false };
  }
};
