// Per-run checkpoint file. Written atomically (write .tmp, rename) after every
// batch completes its onBatch hook. Enables resume() to skip already-processed
// batches on retry.
//
// Shape:
//   { runId, batchDir, batchSize, lastCompletedBatch, updatedAt }

var fs = require('fs');
var fsp = require('fs/promises');
var path = require('path');

function checkpointPath(dir, runId) {
  return path.join(dir, runId + '.json');
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function read(dir, runId) {
  if (!dir) return null;
  try {
    var raw = await fsp.readFile(checkpointPath(dir, runId), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function write(dir, checkpoint) {
  if (!dir) return;
  await ensureDir(dir);
  var target = checkpointPath(dir, checkpoint.runId);
  var tmp = target + '.tmp';
  var payload = JSON.stringify(Object.assign({}, checkpoint, { updatedAt: new Date().toISOString() }));
  await fsp.writeFile(tmp, payload, { encoding: 'utf8' });
  await fsp.rename(tmp, target);
}

async function clear(dir, runId) {
  if (!dir) return;
  await fsp.unlink(checkpointPath(dir, runId)).catch(function() { /* ignore */ });
}

module.exports = { read: read, write: write, clear: clear, checkpointPath: checkpointPath };
