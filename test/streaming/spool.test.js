// Runs with:  node --test test/streaming/spool.test.js

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var fsp = require('fs/promises');
var os = require('os');
var path = require('path');

var { spool, resume, readBatchFile, checkpoint } = require('../../lib/streaming');

async function makeTempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix + '-'));
}

async function* range(n, offset) {
  offset = offset || 0;
  for (var i = 0; i < n; i++) yield { id: i + offset, value: 'row-' + (i + offset) };
}

test('spool writes rotating NDJSON files with batchSize', async function() {
  var dir = await makeTempDir('spool-basic');
  var res = await spool(range(2500), {
    runId:    'r1',
    batchDir: dir,
    batchSize: 1000
  });

  assert.strictEqual(res.totalRows, 2500);
  assert.strictEqual(res.totalBatches, 3);  // 1000 + 1000 + 500
  assert.strictEqual(res.files.length, 3);

  var first = await readBatchFile(res.files[0]);
  assert.strictEqual(first.length, 1000);
  assert.strictEqual(first[0].id, 0);

  var last = await readBatchFile(res.files[2]);
  assert.strictEqual(last.length, 500);
  assert.strictEqual(last[499].id, 2499);
});

test('empty trailing file is cleaned up (exact batchSize multiple)', async function() {
  var dir = await makeTempDir('spool-exact');
  var res = await spool(range(2000), {
    runId:    'r2',
    batchDir: dir,
    batchSize: 1000
  });
  assert.strictEqual(res.totalBatches, 2);
  assert.strictEqual(res.files.length, 2);
  // The run dir should have exactly 2 files.
  var entries = await fsp.readdir(res.batchDir);
  assert.strictEqual(entries.length, 2);
});

test('hooks fire in order — beforeAll before first onBatch, afterAll after last', async function() {
  var dir = await makeTempDir('spool-hooks');
  var log = [];

  await spool(range(2500), {
    runId:    'r3',
    batchDir: dir,
    batchSize: 1000,
    target: {
      async beforeAll(ctx) { log.push('beforeAll:' + path.basename(ctx.firstBatchPath)); },
      async onBatch(rows, meta) { log.push('onBatch:' + meta.batchIndex + ':' + rows.length + (meta.isLast ? ':last' : '')); },
      async afterAll(sum) { log.push('afterAll:' + sum.totalRows + '/' + sum.totalBatches); }
    }
  });

  assert.deepStrictEqual(log, [
    'beforeAll:000000.ndjson',
    'onBatch:0:1000',
    'onBatch:1:1000',
    'onBatch:2:500:last',
    'afterAll:2500/3'
  ]);
});

test('hook error rejects spool and surfaces the first error', async function() {
  var dir = await makeTempDir('spool-err');
  await assert.rejects(spool(range(3000), {
    runId:    'r4',
    batchDir: dir,
    batchSize: 1000,
    target: {
      async onBatch(rows, meta) {
        if (meta.batchIndex === 1) throw new Error('boom on batch 1');
      }
    }
  }), /boom on batch 1/);
});

test('checkpoint written after each batch + cleared on success', async function() {
  var batchDir = await makeTempDir('spool-cp-batches');
  var cpDir    = await makeTempDir('spool-cp-checkpoints');

  await spool(range(3000), {
    runId:         'r5',
    batchDir:      batchDir,
    batchSize:     1000,
    checkpointDir: cpDir
  });

  // Cleared on success.
  var missing = await checkpoint.read(cpDir, 'r5');
  assert.strictEqual(missing, null);
});

test('resume skips completed batches when a checkpoint exists', async function() {
  var batchDir = await makeTempDir('spool-resume-batches');
  var cpDir    = await makeTempDir('spool-resume-checkpoints');

  // Simulate a prior partial run: manually write a checkpoint saying
  // batches 0..1 already completed. Resume should pick up from batch 2.
  await checkpoint.write(cpDir, {
    runId: 'r6', batchDir: path.join(batchDir, 'r6'),
    batchSize: 1000, lastCompletedBatch: 1
  });

  // The "source" of the resume is the untreated remainder — as if the caller
  // built a query that skipped the first 2000 rows.
  var seen = [];
  await resume('r6', range(1000, 2000), {
    batchDir:      batchDir,
    checkpointDir: cpDir,
    batchSize:     1000,
    target: {
      async onBatch(rows, meta) { seen.push({ idx: meta.batchIndex, first: rows[0].id, last: rows[rows.length - 1].id }); }
    }
  });

  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].idx, 2);         // batch index resumed at 2
  assert.strictEqual(seen[0].first, 2000);    // first row from where the source picked up
  assert.strictEqual(seen[0].last, 2999);
});

test('memory ceiling aborts loud when exceeded', async function() {
  var dir = await makeTempDir('spool-mem');
  await assert.rejects(spool(range(10000), {
    runId:       'r7',
    batchDir:    dir,
    batchSize:   1000,
    maxMemoryMB: 0.0001    // ~100 bytes — trips almost immediately
  }), /Streaming memory ceiling exceeded/);
});
