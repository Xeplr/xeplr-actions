// resume(runId, source, opts)
//
// Look up the checkpoint for runId (in opts.checkpointDir), figure out how
// many batches were already completed, then re-invoke spool() telling it to
// skip forward by that much. The caller's `source` must be replayable / at
// least positioned so the first row it yields corresponds to the first row
// of batch `lastCompletedBatch + 1`.
//
// Concretely: if `source` is `for-await SELECT * FROM foo ORDER BY id LIMIT ...
// OFFSET (lastCompletedBatch * batchSize)`, resume() will "just work."

var checkpoint = require('./checkpoint');
var { spool } = require('./spool');

async function resume(runId, source, opts) {
  opts = opts || {};
  if (!runId) throw new Error('resume: runId is required');
  if (!opts.checkpointDir) throw new Error('resume: opts.checkpointDir is required');

  var cp = await checkpoint.read(opts.checkpointDir, runId);
  if (!cp) {
    // No checkpoint → cold start with this runId.
    return spool(source, Object.assign({}, opts, { runId: runId }));
  }

  var startFromBatch = (cp.lastCompletedBatch != null ? cp.lastCompletedBatch : -1) + 1;

  return spool(source, Object.assign({}, opts, {
    runId:          runId,
    startFromBatch: startFromBatch,
    batchSize:      cp.batchSize || opts.batchSize
  }));
}

module.exports = { resume: resume };
