// Uploader — spool + SqlQueue + driver orchestrator.
//
//   const { upload, rollback } = require('@xeplr/actions').uploader;
//
//   await upload({
//     source,          // async iterable of rows
//     driver,          // e.g. require('.../drivers/db/postgres')
//     connection,      // decrypted config object OR pool
//     targetTable,
//     primaryKeys,     // optional — enables UPSERT
//     movementId,      // required — the correlation key
//     queue,           // required — a SqlQueue instance
//     connectionName,  // key used in queue.connections; defaults to targetTable
//     batchSize:          5000,
//     firstBatchScanRows: 1000,
//     metaStore,       // defaults to meta-store-noop
//     mtId1..mtId4,    // optional — forwarded to metaStore verbatim, tenant scoping
//     details,         // optional — forwarded to metaStore verbatim, app-specific context
//                       // (filename, connectionId, who ran it, ...) the engine itself
//                       // has no business knowing about
//     errorTable,      // defaults to `<targetTable>_import_errors`
//     batchDir,        // where NDJSON files spool to. Defaults to os.tmpdir()/xeplr-actions
//     keepBatchFiles,  // default false — clean up NDJSON files after success
//   })
//
// EXECUTION MODEL (production-critical — read this):
//
//   The source (Excel, CSV, DB cursor, etc.) is decoupled from the target
//   DB via the streaming/spool primitive. Rows flow like this:
//
//     [source rows] → spool writes NDJSON files → onBatch reads and pushes to SqlQueue → DB
//
//   Why: a slow DB (or a big SqlQueue backlog) must NEVER back-pressure all
//   the way to the source parser. Some source parsers (xlsx-stream-reader
//   specifically) emit rows from a SAX event handler and don't respect
//   downstream backpressure — an in-memory row pile grows unboundedly until
//   V8 OOMs. Spool breaks that chain by landing rows on disk between the
//   two stages.
//
// See project_xeplr_actions_streaming.md for the full contract.

var os = require('os');
var path = require('path');
var fsp = require('fs/promises');

var { inferColumns } = require('./infer');
var { spool, readBatchFile } = require('../streaming');

// Postgres protocol caps at 65,535 parameters per query. We stay comfortably
// under it — the effective batch cap becomes `maxParamsPerBatch / paramsPerRow`.
var DEFAULT_MAX_PARAMS = 30000;

async function upload(opts) {
  opts = normalizeOptions(opts);
  var driver = opts.driver;
  var startedAt = Date.now();

  var poolIsExternal = looksLikePool(opts.connection);
  var pool = poolIsExternal ? opts.connection : await driver.connect(opts.connection);

  // Shared state across the spool hooks (beforeAll → onBatch* → afterAll).
  var columns = null;
  var effectiveBatchSize = null;
  var totalBatches = 0;

  var spoolResult = null;
  var runDir = null;

  try {
    var summary = await spool(opts.source, {
      runId:        opts.movementId,
      batchDir:     opts.batchDir,
      batchSize:    opts.batchSize,
      maxInFlight:  1,
      maxMemoryMB:  opts.spoolMaxMemoryMB || 128,

      target: {
        // Bootstrap: first batch is on disk. Infer types from it, run DDL,
        // reconcile against the target's existing schema, then compute the
        // safe batch size for INSERT.
        beforeAll: async function(ctx) {
          runDir = ctx.batchDir;
          var sample = await readBatchFile(ctx.firstBatchPath);
          var scanLimit = Math.min(sample.length, opts.firstBatchScanRows);
          var inferred = inferColumns(sample.slice(0, scanLimit));
          columns = await runBootstrap(driver, pool, opts.targetTable, inferred, opts.primaryKeys);
          effectiveBatchSize = Math.min(opts.batchSize, safeBatchSize(columns.length, opts.maxParamsPerBatch));
          await opts.metaStore.recordStart(opts.movementId, {
            targetTable:   opts.targetTable,
            connectionKey: opts.connectionName,   // opaque label, not a real connection
            dbType:        opts.dbType,            // recorded when the caller supplies it
            columns:       columns,
            primaryKeys:   opts.primaryKeys,
            mtId1: opts.mtId1, mtId2: opts.mtId2, mtId3: opts.mtId3, mtId4: opts.mtId4,
            details:       opts.details
          });
        },

        // Each rotated NDJSON file becomes onBatch(rows, meta). We subdivide
        // into safe-INSERT-sized chunks and enqueue each to SqlQueue.
        // addToQueue awaits when queue is over its 200MB backpressure, which
        // in turn awaits spool's next batch — the whole pipeline throttles
        // correctly, but disk (not memory) is the buffer.
        onBatch: async function(rows, _meta) {
          if (!columns) throw new Error('uploader: onBatch before beforeAll — spool contract violated');
          for (var off = 0; off < rows.length; off += effectiveBatchSize) {
            var chunk = rows.slice(off, off + effectiveBatchSize);
            await enqueueBatch(opts, chunk, columns);
            totalBatches++;
          }
        }
      }
    });

    spoolResult = summary;

    // Empty source — spool created no batches, so beforeAll never fired.
    // Nothing to do downstream; return an empty-but-valid summary.
    if (!columns) {
      // beforeAll never fired, so recordStart never happened — this is the
      // only chance to give the row its plan/tenant context (meta-store-knex
      // handles this via its insert-fallback path).
      await opts.metaStore.recordEnd(opts.movementId, {
        status: 'completed', totalRows: 0, totalBatches: 0, completed: 0, dropped: 0,
        targetTable: opts.targetTable, connectionKey: opts.connectionName, dbType: opts.dbType,
        mtId1: opts.mtId1, mtId2: opts.mtId2, mtId3: opts.mtId3, mtId4: opts.mtId4,
        details: opts.details
      });
      return {
        movementId:   opts.movementId,
        tables:       { main: opts.targetTable, errors: opts.errorTable },
        columns:      [],
        totalRows:    0,
        totalBatches: 0,
        completed:    0,
        dropped:      0,
        aborted:      false,
        durationMs:   Date.now() - startedAt
      };
    }

    // Wait for the DB writes to finish (spool has finished feeding the queue).
    await opts.queue.drain();

    var stats = opts.queue.stats(opts.movementId) || {};
    var status = stats.aborted ? 'aborted' : 'completed';
    await opts.metaStore.recordEnd(opts.movementId, {
      status:       status,
      totalRows:    summary.totalRows,
      totalBatches: totalBatches,
      completed:    stats.completed || 0,
      dropped:      stats.dropped || 0
    });

    return {
      movementId:   opts.movementId,
      tables:       { main: opts.targetTable, errors: opts.errorTable },
      columns:      columns,
      totalRows:    summary.totalRows,
      totalBatches: totalBatches,
      completed:    stats.completed || 0,
      dropped:      stats.dropped || 0,
      aborted:      !!stats.aborted,
      durationMs:   Date.now() - startedAt
    };
  } finally {
    // Best-effort cleanup: delete the NDJSON spool directory unless caller
    // asked to keep it (e.g. for later resume / audit).
    if (runDir && !opts.keepBatchFiles) {
      try { await fsp.rm(runDir, { recursive: true, force: true }); } catch (_) {}
    }
    if (!poolIsExternal && pool) await driver.close(pool);
  }
}

// Rollback a movement — drop from main + error tables, clear meta row.
// Graceful queue abort first (in-flight SQLs allowed to settle).
async function rollback(opts) {
  if (!opts || !opts.movementId)  throw new Error('rollback: movementId is required');
  if (!opts.driver)               throw new Error('rollback: driver is required');
  if (!opts.connection)           throw new Error('rollback: connection is required');
  if (!opts.targetTable)          throw new Error('rollback: targetTable is required');

  if (opts.queue) {
    opts.queue.abort(opts.movementId, 'rollback');
    await opts.queue.drain();
  }

  var poolIsExternal = looksLikePool(opts.connection);
  var pool = poolIsExternal ? opts.connection : await opts.driver.connect(opts.connection);

  try {
    var result = await opts.driver.rollbackMovement(pool, opts.targetTable, opts.movementId);
    if (opts.metaStore) {
      await opts.metaStore.recordEnd(opts.movementId, {
        status: 'rolled-back',
        mainDeleted:  result.mainDeleted,
        errorDeleted: result.errorDeleted
      });
    }
    return result;
  } finally {
    if (!poolIsExternal) await opts.driver.close(pool);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────

function normalizeOptions(opts) {
  opts = Object.assign({}, opts);
  if (!opts.source)       throw new Error('upload: source is required');
  if (!opts.driver)       throw new Error('upload: driver is required');
  if (!opts.connection)   throw new Error('upload: connection is required');
  if (!opts.targetTable)  throw new Error('upload: targetTable is required');
  if (!opts.movementId)   throw new Error('upload: movementId is required');
  if (!opts.queue)        throw new Error('upload: queue is required (a SqlQueue)');
  opts.batchSize          = opts.batchSize          || 5000;
  opts.firstBatchScanRows = opts.firstBatchScanRows || 1000;
  // Per-dialect parameter ceiling: PG/MySQL ~65k, but SQL Server caps at 2100
  // params + 1000 rows/statement. Drivers advertise `maxParams`; fall back to
  // the PG-safe default when a driver doesn't.
  opts.maxParamsPerBatch  = opts.maxParamsPerBatch  ||
    (opts.driver && opts.driver.maxParams) || DEFAULT_MAX_PARAMS;
  opts.metaStore          = opts.metaStore          || require('./meta-store-noop');
  opts.errorTable         = opts.errorTable         || (opts.targetTable + '_import_errors');
  opts.connectionName     = opts.connectionName     || opts.targetTable;
  opts.batchDir           = opts.batchDir           ||
    (process.env.XEPLR_ACTIONS_TMP_DIR || path.join(os.tmpdir(), 'xeplr-actions'));
  opts.keepBatchFiles     = !!opts.keepBatchFiles;
  return opts;
}

function safeBatchSize(columnCount, maxParams) {
  var paramsPerRow = columnCount + 1;   // +1 for __xeplr_movement_id__
  return Math.max(1, Math.floor(maxParams / paramsPerRow));
}

async function runBootstrap(driver, pool, targetTable, columns, primaryKeys) {
  await driver.query(pool, driver.buildCreateTableSql(targetTable, columns, primaryKeys));
  await driver.query(pool, driver.buildCreateErrorTableSql(targetTable));

  // Idempotent DDL via the driver's ensure-methods — the guard syntax differs
  // per dialect (PG: IF NOT EXISTS; MySQL: introspect-then-DDL; MSSQL:
  // IF OBJECT_ID/COL_LENGTH), so the driver owns it, not this file.
  await driver.ensureMovementColumn(pool, targetTable);
  await driver.ensureUpsertIndex(pool, targetTable, primaryKeys);

  var targetSchema = await driver.getTableSchema(pool, targetTable);
  var { reconcileColumns } = require('./reconcile');
  var reconciled = reconcileColumns(columns, targetSchema, driver.dataTypeToLogical);

  var missing = reconciled.filter(function(c) { return c.missing; });
  if (missing.length > 0) {
    throw new Error(
      'upload: source has columns not present in target table "' + targetTable + '": ' +
      missing.map(function(c) { return c.name; }).join(', ') +
      '. ALTER TABLE to add them, or omit them from the source.'
    );
  }
  return reconciled;
}

async function enqueueBatch(opts, rows, columns) {
  var driver     = opts.driver;
  var target     = opts.targetTable;
  var movementId = opts.movementId;
  var pks        = opts.primaryKeys;

  function rowsToSql(rs) { return driver.buildInsertSql(target, rs, columns, movementId, pks); }

  var built = rowsToSql(rows);
  await opts.queue.addToQueue({
    movementId: movementId,
    connection: opts.connectionName,
    sql:        built.sql,
    params:     built.params,
    meta: {
      rows:       rows,
      rowCount:   rows.length,
      rowsToSql:  rowsToSql,
      errorTable: opts.errorTable
    }
  });
}

function looksLikePool(v) {
  return v && typeof v.query === 'function' && typeof v.host !== 'string';
}

var { inferColumnType } = require('./infer');

module.exports = {
  upload:          upload,
  rollback:        rollback,
  inferColumns:    inferColumns,
  inferColumnType: inferColumnType,
  makeMetaStore:   require('./meta-store-knex')
};
