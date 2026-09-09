// spool(source, opts)
//
// Consume an async iterable of rows, write them as rotating NDJSON batch
// files, and drive `target` hooks in order. Never throws mid-stream —
// hook errors reject the whole spool.
//
// See project_xeplr_actions_streaming.md for the locked design.

var fs = require('fs');
var fsp = require('fs/promises');
var path = require('path');

var { semaphore, rateLimiter, memoryMonitor, toNDJSON } = require('./utils');
var checkpoint = require('./checkpoint');

var DEFAULTS = {
  batchSize:     5000,
  maxInFlight:   1,
  ratePerSecond: null,
  maxMemoryMB:   256,
  // How many batches may be buffered BEYOND the ones being processed. The
  // reader blocks past this, which pauses the source when the source can be
  // paused. 1 keeps one batch filling while another is written — the overlap
  // this design is for — without letting a fast source outrun a slow target.
  //
  // Raising it trades memory for tolerance of a bursty target: peak footprint
  // is roughly (maxInFlight + maxReadAhead) x batchSize rows.
  maxReadAhead:  1
};

/**
 * @param {AsyncIterable<object>} source
 * @param {object} opts
 * @param {string} opts.runId            stable id — used for the sub-dir + checkpoint file
 * @param {string} opts.batchDir         where the run dir goes (final dir = batchDir/<runId>)
 * @param {number} [opts.batchSize=5000]
 * @param {number} [opts.startFromBatch=0]  skip N batches (drives resume)
 * @param {number} [opts.maxInFlight=1]
 * @param {number} [opts.ratePerSecond]
 * @param {number} [opts.maxMemoryMB=256]
 * @param {string} [opts.checkpointDir]  enables checkpoint writes
 * @param {object} [opts.target]
 * @param {function} [opts.target.beforeAll]  (ctx) => void          fires ONCE, after 1st batch is buffered to disk
 * @param {function} [opts.target.onBatch]    (rows, meta) => void   fires per completed batch, in order
 * @param {function} [opts.target.afterAll]   (summary) => void      fires ONCE, after all batches settle
 * @returns {Promise<{runId, batchDir, totalRows, totalBatches, files, durationMs}>}
 */
async function spool(source, opts) {
  opts = Object.assign({}, DEFAULTS, opts || {});

  if (!opts.runId)    throw new Error('spool: opts.runId is required');
  if (!opts.batchDir) throw new Error('spool: opts.batchDir is required');
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
    throw new Error('spool: source must be an async iterable');
  }

  var target = opts.target || {};
  var runDir = path.join(opts.batchDir, opts.runId);
  await fsp.mkdir(runDir, { recursive: true });

  var started = Date.now();
  var sem = semaphore(opts.maxInFlight);
  var rl  = rateLimiter(opts.ratePerSecond);
  var mem = memoryMonitor(opts.maxMemoryMB);

  // The reader's own governor. Counts batches scheduled but not yet finished;
  // wait() resolves once that falls back within maxReadAhead. Separate from
  // `sem`, which bounds how many run AT ONCE — this bounds how far the reader
  // may get ahead of them.
  var readAhead = (function(limit) {
    var outstanding = 0;
    var waiters = [];
    return {
      enter: function() { outstanding++; },
      leave: function() {
        outstanding = Math.max(0, outstanding - 1);
        // Wake everyone and let them re-test: there is only ever one reader,
        // so this is at most one resumption.
        var w = waiters; waiters = [];
        w.forEach(function(resolve) { resolve(); });
      },
      wait: async function() {
        while (outstanding > limit) {
          await new Promise(function(resolve) { waiters.push(resolve); });
        }
      }
    };
  })(Math.max(0, opts.maxReadAhead));

  // Ordered checkpoint tracking: batches may complete out of order when
  // maxInFlight > 1. `lastContiguous` = highest N where every batch 0..N has
  // reported done. Only checkpoint that highwater — safer for resume.
  var completedSet = new Set();
  var lastContiguous = (opts.startFromBatch || 0) - 1;

  // First-error latch. Since spool guarantees "all hooks awaited in order,
  // any hook error rejects the whole thing," we surface the first error
  // deterministically even if newer batches also fail.
  var firstError = null;

  var fileIndex = opts.startFromBatch || 0;
  var currentFile = null;         // { stream, path, byteCount, rowCount, buffered }
  var beforeAllFired = false;
  var pendingChain = Promise.resolve();      // sequential-arrival ordering into the semaphore
  var filesCreated = [];
  var totalRows = 0;

  async function openNextFile() {
    var name = String(fileIndex).padStart(6, '0') + '.ndjson';
    var filePath = path.join(runDir, name);
    var stream = fs.createWriteStream(filePath);
    currentFile = {
      stream:      stream,
      path:        filePath,
      byteCount:   0,
      rowCount:    0,
      // Buffer rows in memory too — we need them to invoke onBatch(rows, meta).
      // Same footprint as reading the file back, but avoids the round trip.
      buffered:    []
    };
  }

  async function closeCurrentFile() {
    if (!currentFile) return null;
    var cf = currentFile;
    currentFile = null;
    await new Promise(function(resolve) { cf.stream.end(resolve); });
    return cf;
  }

  // Drop the current file if it's empty (avoids leaving 000042.ndjson behind
  // when the source ended right on a rotation boundary).
  async function dropEmptyFile(cf) {
    if (!cf || cf.rowCount > 0) return false;
    await fsp.unlink(cf.path).catch(function() { /* ignore */ });
    return true;
  }

  // Schedule a completed file for hook processing.
  // Adds to the pendingChain to preserve arrival order into the semaphore,
  // then the semaphore itself gates concurrency (maxInFlight).
  function schedule(cf, batchIndex, isLast) {
    readAhead.enter();
    pendingChain = pendingChain.then(async function() {
      if (firstError) { readAhead.leave(); return; }   // short-circuit on failure

      var release = await sem.acquire();

      try {
        // First-batch bootstrap — fire beforeAll AFTER the first batch is on
        // disk (so consumers can peek at it), BEFORE its onBatch runs.
        if (!beforeAllFired && batchIndex === 0 && target.beforeAll) {
          beforeAllFired = true;
          await target.beforeAll({
            runId:          opts.runId,
            batchDir:       runDir,
            firstBatchPath: cf.path
          });
        }

        if (target.onBatch) {
          await target.onBatch(cf.buffered, {
            batchIndex: batchIndex,
            filePath:   cf.path,
            rowCount:   cf.rowCount,
            byteCount:  cf.byteCount,
            isLast:     isLast
          });
        }

        completedSet.add(batchIndex);
        // Advance the contiguous highwater.
        while (completedSet.has(lastContiguous + 1)) {
          lastContiguous++;
          completedSet.delete(lastContiguous);
        }

        // Release the row bytes for GC + memory accounting.
        mem.sub(cf.byteCount);
        cf.buffered = null;

        if (opts.checkpointDir) {
          await checkpoint.write(opts.checkpointDir, {
            runId:              opts.runId,
            batchDir:           runDir,
            batchSize:          opts.batchSize,
            lastCompletedBatch: lastContiguous
          });
        }
      } catch (err) {
        if (!firstError) firstError = err;
      } finally {
        // Before release(), and unconditionally — a batch that threw still
        // stops being outstanding, or a reader waiting on room would block on
        // a batch that is never coming back.
        readAhead.leave();
        release();
      }
    });
  }

  // ─── main pump ──────────────────────────────────────────────────────────
  try {
    await openNextFile();

    for await (var row of source) {
      if (firstError) break;

      await rl.take(1);
      var line = toNDJSON(row);
      mem.add(line.length);

      currentFile.stream.write(line);
      currentFile.byteCount += line.length;
      currentFile.rowCount++;
      currentFile.buffered.push(row);
      totalRows++;

      if (currentFile.rowCount >= opts.batchSize) {
        var idx = fileIndex;
        var cf = await closeCurrentFile();
        filesCreated.push(cf.path);
        schedule(cf, idx, false);
        fileIndex++;
        await openNextFile();

        // WAIT FOR ROOM before filling the next batch.
        //
        // schedule() is deliberately not awaited — batches must be able to
        // process while the next one fills, which is the overlap this whole
        // design exists for. But nothing bounded how far ahead the reader could
        // get, so a source faster than the target (a DB cursor feeding a slower
        // database, which is the normal case for a cross-engine move) piled
        // batches up behind the semaphore until the memory monitor threw:
        //
        //   Streaming memory ceiling exceeded: 129MB > 128MB
        //
        // Read as a limit somebody should raise. It was not: it was a stream
        // that had stopped being a stream. Rows were being read as fast as the
        // source could produce them and held in `buffered` until their batch
        // was written, so peak memory was governed by the SPEED DIFFERENCE
        // between the two databases rather than by batchSize.
        //
        // `maxReadAhead` batches may be buffered beyond the ones in flight;
        // past that the reader blocks here, and blocking here pauses the source
        // itself when the source is a cursor. That is backpressure arriving
        // where it was always supposed to.
        await readAhead.wait();
      }
    }

    // Close the trailing file. If it's empty, drop it. If it had rows,
    // it counts as the last batch.
    var tail = await closeCurrentFile();
    if (tail) {
      if (await dropEmptyFile(tail)) {
        // Nothing to schedule.
      } else {
        var tailIdx = fileIndex;
        filesCreated.push(tail.path);
        schedule(tail, tailIdx, true);
      }
    }

    // Wait for every scheduled hook to settle.
    await pendingChain;
    if (firstError) throw firstError;

    if (target.afterAll) {
      await target.afterAll({
        runId:        opts.runId,
        batchDir:     runDir,
        totalRows:    totalRows,
        totalBatches: filesCreated.length,
        files:        filesCreated,
        durationMs:   Date.now() - started
      });
    }

    // Success — clear the checkpoint so a future resume() with the same runId
    // treats the run as fresh (rather than "already done at batch N").
    if (opts.checkpointDir) {
      await checkpoint.clear(opts.checkpointDir, opts.runId).catch(function() {});
    }

    return {
      runId:        opts.runId,
      batchDir:     runDir,
      totalRows:    totalRows,
      totalBatches: filesCreated.length,
      files:        filesCreated,
      durationMs:   Date.now() - started
    };
  } catch (err) {
    // Best-effort teardown of the currently open file (nothing to schedule).
    if (currentFile) {
      try { await new Promise(function(r) { currentFile.stream.end(r); }); } catch (_) {}
      currentFile = null;
    }
    throw err;
  }
}

/**
 * Read one NDJSON batch file back into an array of rows. Consumer counterpart
 * to spool's writer — one JSON object per non-blank line.
 */
async function readBatchFile(filePath) {
  var raw = await fsp.readFile(filePath, 'utf8');
  return raw.split(/\r?\n/).filter(function(l) { return l.trim().length > 0; }).map(function(l) { return JSON.parse(l); });
}

module.exports = { spool: spool, readBatchFile: readBatchFile };
