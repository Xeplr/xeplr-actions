// Knex-backed MetaStore — persists movement metadata to the `import_meta`
// table in the framework's xeplr_configs DB (control plane), shared across
// apps. Implements the MetaStore interface the uploader calls: getLast /
// recordStart / recordProgress / recordEnd.
//
// Peer deps: knex (+ the pg client — bootstrapConfigDb/import_meta are
// Postgres-only, see xeplr-db/lib/bootstrap-config.js).
//
// Factory shape — bind the knex handle AND this app's name at configuration
// time (service is deliberately constructor-supplied, not env-derived — the
// app that's calling knows its own name, no reason to make callers thread it
// through every recordStart/recordEnd call):
//   const makeStore = require('@xeplr/actions/lib/uploader/meta-store-knex');
//   const store = makeStore(knex, { table: 'import_meta', service: 'xeplr-bi' });
//   await upload({ ..., metaStore: store });
//
// Records NO secrets: `connection_key` is an opaque label the consumer chose,
// never a real connection. `columns`/`primary_keys` describe the movement
// plan. `details` (app-specific context — filename, connectionId, who ran
// it) and `mtId1`-`mtId4` (tenant scoping, same column names as BaseModel)
// are set once at recordStart and never touched by recordEnd — this table is
// shared across apps, so every read/write is scoped by `service` too.

module.exports = function makeKnexMetaStore(knex, options) {
  if (!knex) throw new Error('meta-store-knex: a knex instance is required');
  if (!options || !options.service) throw new Error('meta-store-knex: options.service is required');
  var TABLE = options.table || 'import_meta';
  var SERVICE = options.service;

  return {
    // Most-recent movement for a target table (resume / dedupe / audit).
    // Scoped to this store's own service — a movement recorded by another
    // app is never "the last one" from this app's point of view.
    async getLast(opts) {
      var targetTable = opts && opts.targetTable;
      if (!targetTable) return null;
      var row = await knex(TABLE)
        .where({ service: SERVICE, target_table: targetTable })
        .orderBy('started_at', 'desc')
        .first();
      return row || null;   // pg returns jsonb columns already parsed
    },

    // Open the movement row in 'running' state. Upsert on id so a re-run /
    // resume of the same movementId overwrites its prior 'running' row.
    async recordStart(movementId, plan) {
      plan = plan || {};
      await knex(TABLE)
        .insert({
          id:             movementId,
          service:        SERVICE,
          mtId1:          plan.mtId1 || null,
          mtId2:          plan.mtId2 || null,
          mtId3:          plan.mtId3 || null,
          mtId4:          plan.mtId4 || null,
          details:        plan.details ? JSON.stringify(plan.details) : null,
          target_table:   plan.targetTable   || null,
          connection_key: plan.connectionKey || null,
          db_type:        plan.dbType         || null,
          status:         'running',
          primary_keys:   plan.primaryKeys ? JSON.stringify(plan.primaryKeys) : null,
          columns:        plan.columns     ? JSON.stringify(plan.columns)     : null,
          error:          null,
          started_at:         knex.fn.now(),
          ended_at:           null,
          recordModifiedDate: knex.fn.now()
        })
        .onConflict('id')
        .merge();
    },

    // Increment running counters. delta = { completed?, dropped?, totalRows?, totalBatches? }
    async recordProgress(movementId, delta) {
      delta = delta || {};
      var patch = { recordModifiedDate: knex.fn.now() };
      var COLS = { completed: 'completed', dropped: 'dropped', totalRows: 'total_rows', totalBatches: 'total_batches' };
      var touched = false;
      for (var key in COLS) {
        if (typeof delta[key] === 'number') {
          var col = COLS[key];
          patch[col] = knex.raw('?? + ?', [col, delta[key]]);
          touched = true;
        }
      }
      if (!touched) return;
      await knex(TABLE).where({ id: movementId }).update(patch);
    },

    // Close the movement. Upserts: the empty-source path calls recordEnd
    // WITHOUT a prior recordStart (beforeAll never fires), so a missing row
    // must be created rather than silently no-op'd.
    async recordEnd(movementId, result) {
      result = result || {};
      var patch = {
        status:             result.status || 'completed',
        ended_at:           knex.fn.now(),
        recordModifiedDate: knex.fn.now()
      };
      if (typeof result.totalRows    === 'number') patch.total_rows    = result.totalRows;
      if (typeof result.totalBatches === 'number') patch.total_batches = result.totalBatches;
      if (typeof result.completed    === 'number') patch.completed     = result.completed;
      if (typeof result.dropped      === 'number') patch.dropped       = result.dropped;
      if (result.error) patch.error = String(result.error.message || result.error);
      // rollback reports mainDeleted/errorDeleted — keep them in meta jsonb.
      if (result.mainDeleted != null || result.errorDeleted != null) {
        patch.meta = JSON.stringify({ mainDeleted: result.mainDeleted, errorDeleted: result.errorDeleted });
      }

      var updated = await knex(TABLE).where({ id: movementId }).update(patch);
      if (!updated) {
        // No prior recordStart (empty-source path — beforeAll never fires) —
        // this is the only chance to stamp service/tenant/plan context, or
        // the row is left sparse forever. Caller may pass these through
        // result for exactly this case (see uploader/index.js's empty-source
        // recordEnd call).
        var fallback = {
          id: movementId,
          service: SERVICE,
          mtId1: result.mtId1 || null,
          mtId2: result.mtId2 || null,
          mtId3: result.mtId3 || null,
          mtId4: result.mtId4 || null,
          details: result.details ? JSON.stringify(result.details) : null,
          target_table: result.targetTable || null,
          connection_key: result.connectionKey || null,
          db_type: result.dbType || null,
          started_at: knex.fn.now()
        };
        await knex(TABLE)
          .insert(Object.assign(fallback, patch))
          .onConflict('id')
          .merge();
      }
    }
  };
};
