// Local filesystem source — thin wrappers over fs. No peer deps.
//
// openStream(config)                → node stream (Readable)
// writeFile(config, {content|filePath})
// listFiles(config)                  → [{ name, size, mtime }]
// moveFile(config, { from, to })    → void
// deleteFile(config)                 → void
//
// `config.path` is the file/dir path — local source config is intentionally
// minimal since fs handles most concerns natively. Every path is inside the
// tenant's own folder (lib/dataDir.js): a name, or a full path already in it.

var fs = require('fs');
var fsp = require('fs/promises');
var path = require('path');
var dataDir = require('../../dataDir');

function at(p, what) { return dataDir.resolve(p, what || 'The file'); }

module.exports = {
  requires: [],

  async openStream(config) {
    if (!config || !config.path) throw new Error('local source: config.path is required');
    return fs.createReadStream(at(config.path), config.encoding ? { encoding: config.encoding } : {});
  },

  // Formats that need random access (e.g. .xlsx via unzipper — the zip central
  // directory lives at the file tail) request a path instead of a stream.
  // Local: return the path directly. Remote sources (SFTP, Google, etc.)
  // must implement this by downloading to a caller-provided tmp path.
  async openPath(config) {
    if (!config || !config.path) throw new Error('local source: config.path is required');
    return at(config.path);
  },

  async writeFile(config, opts) {
    if (!config.path) throw new Error('local source: config.path is required for writeFile');
    if (opts.filePath) {
      var to = at(config.path);
      await fsp.copyFile(at(opts.filePath, 'The file to copy'), to);
      return { bytes: (await fsp.stat(to)).size };
    }
    if (opts.content != null) {
      await fsp.writeFile(at(config.path), opts.content);
      return { bytes: Buffer.byteLength(opts.content) };
    }
    throw new Error('local source: writeFile requires opts.content or opts.filePath');
  },

  async listFiles(config) {
    var dir = at(config.path, 'The folder');
    var entries = await fsp.readdir(dir, { withFileTypes: true });
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e.isFile()) continue;
      var full = path.join(dir, e.name);
      var stat = await fsp.stat(full);
      out.push({ name: e.name, path: full, size: stat.size, mtime: stat.mtime.toISOString() });
    }
    return out;
  },

  async moveFile(_config, opts) {
    if (!opts || !opts.from || !opts.to) throw new Error('local source: moveFile requires from + to');
    await fsp.rename(at(opts.from, 'The file to move'), at(opts.to, 'Where it goes'));
  },

  async deleteFile(config) {
    if (!config.path) throw new Error('local source: config.path is required for deleteFile');
    await fsp.unlink(at(config.path));
  }
};
