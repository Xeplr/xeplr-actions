// db-move action — ONE data movement, source database to target database.
//
// Composes: drivers.db.<source> + drivers.db.<target> + uploader.upload + SqlQueue
//
// ── why this is not db-fetch chained into db-push ────────────────────────
//
// It could be, and it would be worse. db-fetch spools its whole result to an
// NDJSON file and db-push reads it back, so a 40M-row move lands on disk in
// full before a single row reaches the target. That round trip buys nothing
// here: driver.fetchStream is an ASYNC GENERATOR of rows and upload() takes an
// async iterable of rows, so the two plug straight together and the movement is
// one streamed pass. upload()'s own spool still breaks backpressure between
// source and target — that is what it is for — it just does it in batches
// rather than staging the entire result first.
//
// The chained version stays useful for what it is good at: two runs at
// different times, or a file that outlives the movement. This is for when you
// want the rows in the target.
//
// ── one window, and nothing about schedules ──────────────────────────────
//
// The action moves ONE window and has no idea whether it is a backfill, an
// hourly top-up or somebody pressing a button. That is deliberate and it is
// the whole seam:
//
//   db-move(window: Jan 1 → Feb 1)   ┐
//   db-move(window: Feb 1 → Mar 1)   ├ a monthly backfill
//   db-move(window: Mar 1 → Apr 1)   ┘
//   db-move(window: 14:00 → 15:00)     an hourly job
//   db-move()                          everything, once
//
// Same action every time. "Incremental", "historical" and "one-off" are not
// features of a movement; they are a caller deciding which window to ask for.
// Whatever schedules it — a job, a workflow, a for-loop — lives outside.
//
// ── the column mapping is SQL, not a transform ───────────────────────────
//
// `columns: [{ from: 'date', to: 'dt_created' }]` becomes
// `SELECT "date" AS "dt_created"`, so rows arrive already carrying TARGET
// names. inferColumns and buildCreateTableSql then need no notion of mapping
// at all: the CREATE is built from the target names, the SELECT from the source
// names, and nothing in the uploader has to know the two ever differed.
//
// A stored procedure is the exception — you cannot alias `EXEC proc` — so for
// mode 'procedure' the mapping is applied as a row transform on the way past.
// Same for the window: a table or query gets a WHERE, a procedure has to be
// handed the range as its own parameters, and if it does not take them then
// this refuses rather than filtering a full result set in memory and calling it
// incremental.

var { upload } = require('../../uploader');
var dbDrivers  = require('../../drivers/db');
var { SqlQueue } = require('@xeplr/utils/lib/queue');
// HOW A PROCEDURE IS CALLED lives in one place, shared with the db-procedure
// action — this file used to own that knowledge, which meant a procedure could
// only be called by moving its output somewhere. See drivers/db/procedure.js.
var procedureCall = require('../../drivers/db/procedure');
var { generateId } = require('@xeplr/utils/lib/helpers');

var WRITE_MODES = ['replace', 'upsert', 'append'];

module.exports = {
  name: 'db-move',
  description: 'Move one window of rows from a source DB (table, query or procedure) into a ' +
               'target DB table, in a single streamed pass. Column mapping becomes SELECT ' +
               'aliases; writeMode is replace | upsert | append.',
  requires: [],   // per-driver requires checked at runtime once the dbTypes are known

  inputSchema: [
    { name: 'sourceDbType',    type: 'string', required: true, default: 'postgres', order: 1,
      description: 'postgres | mysql | mssql' },
    { name: 'sourceConnection', type: 'object', required: true, order: 2,
      description: 'Source connection config: { host, port, user, password, database }' },
    { name: 'mode',            type: 'string', default: 'table', order: 3,
      description: '"table" | "query" | "procedure"' },
    { name: 'table',           type: 'string', order: 4,
      description: 'Source table (mode="table").' },
    { name: 'sql',             type: 'string', order: 5,
      description: 'Source SQL (mode="query") or the procedure name (mode="procedure").' },
    { name: 'params',          type: 'array',  order: 6,
      description: 'Bind params for the source SQL or procedure.' },

    { name: 'columns',         type: 'array',  order: 7,
      description: 'Mapping [{ from, to }]. Omitted = every source column, unrenamed.' },

    { name: 'targetDbType',    type: 'string', required: true, default: 'postgres', order: 8,
      description: 'postgres | mysql | mssql' },
    { name: 'targetConnection', type: 'object', required: true, order: 9,
      description: 'Target connection config.' },
    { name: 'targetTable',     type: 'string', required: true, order: 10 },

    { name: 'writeMode',       type: 'string', default: 'append', order: 11, group: 'Write options',
      description: 'replace (truncate first) | upsert (needs primaryKeys) | append' },
    { name: 'primaryKeys',     type: 'array',  order: 12, group: 'Write options',
      description: 'Target column names for UPSERT. Required when writeMode="upsert".' },

    { name: 'window',          type: 'object', order: 13, group: 'Advanced',
      description: 'One window: { column, from, to }. Half-open — from <= x < to. ' +
                   'Omitted = no filter. For mode="procedure", also needs { fromParam, toParam }.' },

    { name: 'where',           type: 'string', order: 13.5, group: 'Advanced',
      description: 'A raw SQL condition ANDed into the source query — "department_id = 42", ' +
                   '"EXTRACT(HOUR FROM created) = 2". Runs on the SOURCE database, so its own ' +
                   'functions and dialect apply. Omitted = no condition. Not supported for ' +
                   'mode="procedure", which has no WHERE to add it to.' },
    { name: 'movementId',      type: 'string', order: 14, group: 'Advanced',
      description: 'Correlation key for rollback. Defaults to system.occurrenceId or a fresh id.' },
    { name: 'batchSize',       type: 'number', default: 5000, order: 15, group: 'Performance' },
    { name: 'concurrency',     type: 'number', default: 4,    order: 16, group: 'Performance' }
  ],

  execute: async function(ctx) {
    var input = ctx.input || {};
    var system = ctx.system || {};

    var writeMode = input.writeMode || 'append';
    if (WRITE_MODES.indexOf(writeMode) === -1) {
      throw new Error('db-move: writeMode must be one of ' + WRITE_MODES.join(', ') + ' (got "' + writeMode + '")');
    }
    var primaryKeys = (input.primaryKeys && input.primaryKeys.length) ? input.primaryKeys : null;
    // Refused rather than quietly downgraded to an append. An upsert that
    // silently inserts is a duplicate every run, discovered a week later.
    if (writeMode === 'upsert' && !primaryKeys) {
      throw new Error('db-move: writeMode "upsert" requires primaryKeys');
    }

    var sourceDriver = dbDrivers.getDriver(input.sourceDbType);
    dbDrivers.checkDriverRequires('db-move', input.sourceDbType, sourceDriver);
    var targetDriver = dbDrivers.getDriver(input.targetDbType);
    dbDrivers.checkDriverRequires('db-move', input.targetDbType, targetDriver);
    if (typeof sourceDriver.fetchStream !== 'function') {
      throw new Error('db-move: source driver "' + input.sourceDbType + '" does not implement fetchStream');
    }

    var plan = buildSourcePlan(sourceDriver, input);
    var movementId = input.movementId || system.occurrenceId || ('mv_' + generateId());

    // ONE LINE PER STEP, in the order they actually happen — the point is a
    // log somebody can read top to bottom and know exactly what this run did
    // and how far it got, without guessing from a single packed summary
    // sentence. system.log is optional: a caller that passes nothing (a plain
    // runAction call with no logging wired up) costs this action nothing.
    if (system.log) {
      // The correlation key — what a MoveRun row stores, what rollback would
      // undo, and what ties this run to import_meta in xeplr_configs. Logged
      // first and by itself so it's the one thing findable by eye even in a
      // long log, if that's what someone is cross-referencing against.
      // THE RUN'S OWN SHAPE, as facts as well as sentences.
      //
      // This is the block that answers "what was this movement even supposed
      // to do" — the first question when the numbers look wrong — so an
      // analyzer needs it structured rather than reconstructed from prose.
      // Identifiers, schema and configuration only; no customer values.
      system.log('Movement id: ' + movementId,
        { phase: 'start', event: 'movement_id', movementId: movementId });
      system.log('Source: ' + input.sourceDbType + ' "' + connDbName(input.sourceConnection) + '" — ' + describeSource(input),
        { phase: 'start', event: 'source', dbType: input.sourceDbType,
          database: connDbName(input.sourceConnection), mode: input.mode || 'table',
          table: input.table || null });
      system.log('Target: ' + input.targetDbType + ' "' + connDbName(input.targetConnection) + '" — table "' + input.targetTable + '"',
        { phase: 'start', event: 'target', dbType: input.targetDbType,
          database: connDbName(input.targetConnection), table: input.targetTable });
      system.log('Columns: ' + describeColumns(input.columns),
        { phase: 'start', event: 'columns', count: (input.columns || []).length });
      system.log('Write mode: ' + describeWriteMode(writeMode, primaryKeys),
        { phase: 'start', event: 'write_mode', writeMode: writeMode, primaryKeys: primaryKeys || [] });
      system.log('Window: ' + describeWindow(input.window),
        { phase: 'start', event: 'window',
          // Bounds are CONFIGURATION — a date range somebody chose — not rows
          // out of the customer's tables. The `where` text is deliberately not
          // here for the opposite reason; see the SQL line.
          window: input.window || null });
    }

    var sourcePool = await sourceDriver.connect(input.sourceConnection);
    var targetPool = await targetDriver.connect(input.targetConnection);

    var connectionName = input.targetTable;
    var connections = {};
    connections[connectionName] = targetPool;
    // Counted here rather than derived later: the queue reports rows, and
    // "20 rows across 3 statements" is a different diagnosis from "20 rows in
    // 20 statements" — the first is a bad batch, the second is bad data.
    var droppedGroups = 0;
    var queue = new SqlQueue({
      connections: connections,
      // Through driver.query, not conn.query: each driver normalizes the
      // result shape AND binds params dialect-correctly.
      executor: async function(item, conn) { await targetDriver.query(conn, item.sql, item.params || []); },
      concurrency: input.concurrency || 4,
      maxAttempts: 3,

      // WHY A ROW DID NOT ARRIVE.
      //
      // The queue hands the failing statement, its rows and the database's own
      // error to this hook — and its default is a no-op, so until now every one
      // of those was discarded the moment it happened. The run then reported
      // "1000 read, 980 loaded, 20 dropped" and nothing, anywhere, could say
      // why those 20 went missing. That is the single question a client asks.
      //
      // A BOUNDED SAMPLE, not every row: a broken column drops the whole batch
      // and writing 5000 rejected rows into the log makes it unreadable and
      // pushes out the lines around it. Three is enough to see the shape of
      // what failed; the count says how much of it there was.
      onErrorTable: function(info) {
        droppedGroups++;
        var meta = (info.item && info.item.meta) || {};
        var rows = meta.rows || [];
        var reason = (info.error && info.error.message) || 'unknown error';
        if (!system.log) return;
        // WHICH BATCH, WHY, AND ONE ROW TO LOOK AT.
        //
        // Not every failing row: a batch fails for one reason, and printing
        // five hundred variations of it buries the line that says which batch
        // it was. What a person needs to act is the reference (to find and
        // re-run it), the reason (to know what to fix) and one example (to see
        // the shape). They can read the rest from the source.
        // THE FACTS IN meta, THE SENTENCE IN THE MESSAGE.
        //
        // A log analyzer reads meta and never parses the wording — so a line
        // can be rephrased without breaking anything that depends on it, and
        // the analyzer can group, count and filter by batch or reason without
        // regexes. Nothing here is customer data: identifiers, counts and the
        // database's own error text.
        system.log('BATCH ' + (meta.batchRef || '?') + ' FAILED — ' + rows.length +
          ' row(s) dropped: ' + reason, {
          phase: 'write',
          event: 'batch_failed',
          batchRef: meta.batchRef || null,
          rows: rows.length,
          reason: reason,
          // The DATABASE's own name for the failure, and whether it was ever
          // worth retrying — '23502'/deterministic groups cleanly across
          // thousands of lines where the message text does not, and it says
          // in one field whether a re-run could plausibly behave differently.
          errorCode: info.errorCode || null,
          errorKind: info.errorKind || null,
          attempts: info.attempts || null,
          rowIdentity: rows.length ? rowIdentity(rows[0], primaryKeys) : null,
          movementId: movementId,
          targetTable: input.targetTable
        });
      }
    });

    try {
      // TRUNCATE BEFORE READING A SINGLE ROW, and only if the table is already
      // there — on a first run upload() creates it, and truncating a table that
      // does not exist is an error rather than a no-op.
      //
      // If the load then fails the target is empty until somebody runs it
      // again. That is the accepted trade: the alternative (stage and swap, or
      // delete-by-previous-movement) costs a second copy of the data or a
      // schema change, and re-running is what people do anyway.
      var truncated = false;
      if (writeMode === 'replace') truncated = await truncateIfExists(targetDriver, targetPool, input.targetTable);
      if (truncated && system.log) system.log('Target table emptied first (replace)',
        { phase: 'write', event: 'target_truncated', table: input.targetTable });

      // THE SOURCE'S DECLARED TYPES, where the source has any to declare.
      //
      // Without this upload() infers from the first batch's VALUES, which is
      // correct for a CSV and quietly lossy here — see declaredColumns.
      var declared = await declaredColumns(sourceDriver, sourcePool, input, plan);

      // The actual SQL, so a discrepancy is checkable against the source
      // directly rather than trusted on faith — this is what actually ran,
      // not a paraphrase of it. Truncated: a query source's own SQL can be
      // arbitrarily long, and the point is a debugging trail, not a full copy.
      // The SQL is the answer to every "why did these rows come through"
      // question, so it is a fact, not only a sentence. Parameters are NOT
      // included: a window's bounds are fine, but a `where` can carry values
      // from the customer's own data.
      if (system.log) system.log('SQL: ' + truncateForLog(plan.sql),
        { phase: 'read', event: 'source_sql', sql: plan.sql, mode: input.mode || 'table' });
      if (system.log) system.log('Starting the read…', { phase: 'read', event: 'read_started' });
      var rows = sourceDriver.fetchStream(sourcePool, {
        sql: plan.sql,
        params: plan.params,
        batchSize: input.batchSize || 5000
      });
      // Only a procedure needs this — see the note at the top. For a table or
      // query the aliases are already in the SELECT and the rows arrive named
      // the way the target wants them.
      if (plan.renameInJs) rows = renamed(rows, plan.renameInJs);

      var result = await upload({
        source:         rows,
        driver:         targetDriver,
        connection:     targetPool,
        targetTable:    input.targetTable,
        // A replace has just emptied the table, so there is nothing to conflict
        // with — passing keys would build an upsert that can never fire and
        // would demand a unique index the target may not have.
        primaryKeys:    writeMode === 'upsert' ? primaryKeys : null,
        // Null for a query or a procedure — upload() falls back to inference.
        columns:        declared,
        movementId:     movementId,
        queue:          queue,
        connectionName: connectionName,
        dbType:         input.targetDbType,      // recorded in import_meta
        metaStore:      ctx.metaStore,
        batchSize:      input.batchSize,
        // Passed through from the caller's `system`, not from `input` — a
        // progress reporter is a function, and an action's input is data that
        // has to survive being stored in a job row.
        onProgress:     system.onProgress || null
      });

      // Every count upload() has, not just the headline one — "read" and
      // "loaded" legitimately differ (a dropped row, an upsert that matched
      // and updated rather than inserted), and the discrepancy itself is
      // exactly what this line exists to make checkable without a query.
      if (system.log) {
        var bits = [(result.completed || 0) + ' loaded'];
        if ((result.totalRows || 0) !== (result.completed || 0)) bits.push((result.totalRows || 0) + ' read');
        if (result.dropped) {
          bits.push(result.dropped + ' dropped' +
            (droppedGroups ? ' in ' + droppedGroups + ' failed batch(es) — see the BATCH … FAILED lines for which' : ''));
        }
        bits.push((result.totalBatches || 0) + ' batch' + (result.totalBatches === 1 ? '' : 'es'));
        bits.push(((result.durationMs || 0) / 1000).toFixed(1) + 's');
        // THE LINE THE WHOLE LOG EXISTS FOR. Every number a discrepancy
        // question starts from, in one record — so "1000 read, 980 loaded" is
        // a fact an analyzer can compare against the source, not a sentence it
        // has to pick apart.
        system.log('Done — ' + bits.join(', ') + ' — into "' + input.targetTable + '"' +
          (result.aborted ? ' (ABORTED)' : ''), {
          phase: 'summary',
          event: result.aborted ? 'movement_aborted' : 'movement_done',
          movementId: movementId,
          targetTable: input.targetTable,
          read: result.totalRows || 0,
          loaded: result.completed || 0,
          dropped: result.dropped || 0,
          failedBatches: droppedGroups,
          batches: result.totalBatches || 0,
          durationMs: result.durationMs || 0,
          aborted: Boolean(result.aborted),
          writeMode: writeMode
        });
      }

      return Object.assign({}, result, {
        movementId: movementId,
        writeMode:  writeMode,
        truncated:  truncated,
        // Echoed back so a caller driving a backfill can log which window this
        // was without holding on to what it sent.
        window:     input.window || null,
        sourceSql:  plan.sql
      });
    } finally {
      queue.stop();
      await sourceDriver.close(sourcePool);
      await targetDriver.close(targetPool);
    }
  }
};

/** A short, human phrase for what's being read — the log line, not the SQL. */
function describeSource(input) {
  var mode = input.mode || (input.table ? 'table' : 'query');
  if (mode === 'table') return 'table "' + input.table + '"';
  if (mode === 'procedure') return 'procedure "' + input.sql + '"';
  return 'a query';
}

/** The database name off a connection config — never the password. */
function connDbName(connection) {
  return (connection && connection.database) || '?';
}

/** What range, if any, this run actually asked for. */
function describeWindow(win) {
  if (!win) return 'none — moving everything';
  if (win.fromParam || win.toParam) {
    return '@' + (win.fromParam || '?') + ' / @' + (win.toParam || '?') + ': ' +
      (win.from || 'anything') + ' → ' + (win.to || 'now');
  }
  if (win.column) return win.column + ': ' + (win.from || 'anything') + ' → ' + (win.to || 'now');
  return 'none — moving everything';
}

/** A log line has room for the SQL, not a second copy of a 50KB query. */
/**
 * HOW TO FIND A ROW, NOT WHAT IS IN IT.
 *
 * Logs stay on the customer's own machine, but they are still read by support
 * engineers, copied into tickets and pasted into chats — so a log line is not
 * a safe place for their data, and printing one costs nothing to avoid.
 *
 * The primary key is the reference somebody needs to go and look at the row in
 * the source; the column list says what shape the statement had. Neither is
 * the customer's content. With no primary key configured there is nothing safe
 * to identify it by, and saying so is better than printing the row instead.
 */
function rowIdentity(row, primaryKeys) {
  if (!row || typeof row !== 'object') return '<no row>';
  var keys = Object.keys(row);
  if (primaryKeys && primaryKeys.length) {
    var parts = primaryKeys.map(function(k) {
      // The key VALUE is the one thing that has to travel — it is the address
      // of the row, and without it the reference is not a reference.
      return k + '=' + String(row[k] === undefined ? '<missing>' : row[k]).slice(0, 60);
    });
    return parts.join(', ') + '  (' + keys.length + ' columns)';
  }
  return 'no primary key configured — cannot identify the row; columns were: ' +
    truncateForLog(keys.join(', '), 300);
}

function truncateForLog(sql, limit) {
  var max = limit || 800;
  var s = String(sql || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** What the column mapping actually does, for the log line. */
function describeColumns(columns) {
  var mapping = normalizeMapping(columns);
  if (!mapping.length) return 'all source columns, unrenamed';
  return mapping.map(function(c) { return c.from === c.to ? c.from : c.from + ' → ' + c.to; }).join(', ');
}

/**
 * The write mode, with the detail that actually matters for each one.
 *
 * NOT "target emptied first" for replace here — whether that actually
 * happens depends on whether the table exists yet, which isn't known until
 * truncateIfExists runs; that outcome gets its own log line when it does.
 */
function describeWriteMode(writeMode, primaryKeys) {
  if (writeMode === 'upsert') return 'upsert (key: ' + (primaryKeys || []).join(', ') + ')';
  return writeMode;
}

// ── what the columns actually are ────────────────────────────────────────

/**
 * The source's DECLARED column types, in the target's names — or null when the
 * source has none to declare.
 *
 * Inference reads values, and for a database source that is throwing away an
 * answer the server already holds. Three ways it goes wrong, all of them quiet
 * and all of them baked into a CREATE TABLE that outlives the sample:
 *
 *   Postgres returns `numeric` to node as a STRING. A money column arrives as
 *   strings, infers as text, and the target column is created TEXT. You find
 *   out when somebody tries to SUM it.
 *
 *   A column that is all-null in the first batch has no type, so it becomes
 *   text — and stays text once the table exists.
 *
 *   A zero-padded code ('007') looks like a number and loses its zeros.
 *
 * Only for mode 'table': a query or a procedure has no single table to
 * describe. Both dialects CAN describe a result set — Postgres by preparing,
 * SQL Server via sp_describe_first_result_set — but that is a per-driver
 * capability that does not exist yet, so those fall back to inference and the
 * caveat above still applies to them.
 */
async function declaredColumns(driver, pool, input, plan) {
  var mode = input.mode || (input.table ? 'table' : 'query');
  if (mode !== 'table' || !input.table) return null;
  if (typeof driver.getTableSchema !== 'function' || typeof driver.dataTypeToLogical !== 'function') return null;

  var schema = await driver.getTableSchema(pool, input.table);
  if (!schema || !schema.length) return null;

  var byName = {};
  schema.forEach(function(c) { byName[c.name] = c; });

  var mapping = normalizeMapping(input.columns);
  // No mapping means every source column, unrenamed — so the declaration is
  // the source's own schema in its own order.
  var wanted = mapping.length
    ? mapping
    : schema.map(function(c) { return { from: c.name, to: c.name }; });

  var out = [];
  for (var i = 0; i < wanted.length; i++) {
    var src = byName[wanted[i].from];
    // A mapped column the source does not have is left out rather than
    // guessed at — the SELECT will fail on it anyway, with a better message
    // than anything invented here.
    if (!src) return null;
    out.push({ name: wanted[i].to, type: driver.dataTypeToLogical(src.dataType) });
  }
  return out.length ? out : null;
}

// ── the source query ─────────────────────────────────────────────────────

/**
 * Turn the source inputs into { sql, params, renameInJs }.
 *
 * `renameInJs` is set only where the mapping cannot be expressed as a SELECT
 * alias — which is procedures, and only procedures.
 */
function buildSourcePlan(driver, input) {
  var mode = input.mode || (input.table ? 'table' : 'query');
  var ph = placeholders(input.sourceDbType);
  var mapping = normalizeMapping(input.columns);
  // A window is "on" when it has something to address BY — a column for
  // table/query, or fromParam/toParam for a procedure (see procedurePlan).
  // Checking `column` alone here meant a procedure's window was silently
  // dropped before procedurePlan ever saw it, regardless of fromParam/toParam.
  var win = input.window && (input.window.column || (input.window.columns && input.window.columns.length) ||
    input.window.fromParam || input.window.toParam)
    ? input.window : null;

  if (mode === 'procedure') return procedurePlan(driver, input, mapping, win);

  var selectList = mapping.length
    ? mapping.map(function(c) {
        return driver.quoteIdent(c.from) + ' AS ' + driver.quoteIdent(c.to);
      }).join(', ')
    : '*';

  var from;
  if (mode === 'table') {
    if (!input.table) throw new Error('db-move: mode "table" requires input.table');
    from = driver.quoteIdent(input.table);
  } else if (mode === 'query') {
    if (!input.sql) throw new Error('db-move: mode "query" requires input.sql');
    // WRAPPED, so the mapping and the window apply to whatever the caller
    // wrote without this having to parse it. The alias is not decoration —
    // Postgres and MySQL both reject a derived table without one.
    from = '(' + input.sql + ') AS __src';
  } else {
    throw new Error('db-move: unsupported mode "' + mode + '" (use "table", "query" or "procedure")');
  }

  var params = (input.params || []).slice();
  var sql = 'SELECT ' + selectList + ' FROM ' + from;

  // Declared out here, not inside the window branch: a `where` with no window
  // is an ordinary thing to ask for, and `var` would have hoisted the name
  // while leaving it undefined — so the push below threw instead of filtering.
  var clauses = [];

  if (win) {
    // HALF-OPEN: from <= x < to. Closed at both ends would move the boundary
    // row twice — harmless under upsert, a duplicate under append — and
    // consecutive windows are the normal case here, so the boundary is hit
    // every single run rather than occasionally.
    if (win.columns && win.columns.length) {
      // Independent watermarks, OR'd — a row counts as "new" the moment ANY
      // tracked column exceeds its own last-seen max (not a composite tuple
      // tie-break). A column with no watermark yet (null `from` — nothing in
      // the target for it) is left out of the OR entirely rather than forced
      // true/false; if every column is null (a fresh target) the whole group
      // is skipped below, same as the single-column "load everything the
      // first time" case.
      var orParts = [];
      win.columns.forEach(function(c) {
        if (c.from == null) return;
        orParts.push(driver.quoteIdent(c.column) + ' >= ' + ph(params.length));
        params.push(c.from);
      });
      if (orParts.length) clauses.push('(' + orParts.join(' OR ') + ')');
    } else {
      var col = driver.quoteIdent(win.column);
      if (win.from != null) { clauses.push(col + ' >= ' + ph(params.length)); params.push(win.from); }
      if (win.to != null)   { clauses.push(col + ' < '  + ph(params.length)); params.push(win.to); }
    }
  }

  // THE CALLER'S OWN CONDITION, ANDed with the window rather than replacing it.
  //
  // Both are filters on the same rows and both must hold: an incremental run
  // of "department 42 only" means new rows AND that department, never one or
  // the other. Parenthesised because a condition containing OR would otherwise
  // bind loosely and quietly widen the window it was supposed to narrow.
  //
  // NOT parameterised, and this is the same trust boundary mode="query"
  // already sits on: a caller who can write a source SELECT can write a WHERE.
  // What it must never become is a field an END USER types into without that
  // being a deliberate decision — see the note in moveService.
  if (input.where && String(input.where).trim()) {
    clauses.push('(' + String(input.where).trim() + ')');
  }

  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');

  return { sql: sql, params: params, renameInJs: null };
}

// normalizeParamValue moved to drivers/db/procedure.js with the rest of the
// call-building — the only caller left was the procedure path, and a second
// copy of "what may be bound" is how two callers start disagreeing about it.
// Re-exported here for anything reaching for it by name.
var normalizeParamValue = procedureCall.normalizeParamValue;

/**
 * A procedure call.
 *
 * Neither the alias nor the WHERE is available: `SELECT … FROM (EXEC p) x` is
 * not a thing in any of the three dialects. So the window has to be handed to
 * the procedure as its own parameters, and the caller has to say which ones
 * those are. If it cannot, this REFUSES — the alternative is pulling the whole
 * result set and filtering it in memory, which costs exactly what incremental
 * was meant to save while looking like it worked.
 */
function procedurePlan(driver, input, mapping, win) {
  if (!input.sql) throw new Error('db-move: mode "procedure" requires input.sql (the procedure name)');

  // ONE implementation of how a procedure is called — including what a window
  // means to one — shared with the db-procedure action. A window here is not a
  // WHERE but two more parameters; the builder owns that rule, and its refusal
  // when they are not named is the same refusal this file used to make itself.
  //
  // returnsRows is always true here and cannot be anything else: a movement
  // exists to move the rows, so on Postgres this is always the set-returning
  // FUNCTION form rather than CALL, which returns nothing a client can read.
  var call;
  try {
    call = procedureCall.buildProcedureCall({
      driver: driver,
      dbType: input.sourceDbType,
      name: input.sql,
      params: input.params,
      window: win,
      returnsRows: true
    });
  } catch (err) {
    // The shared builder does not know whose call this is; the message a user
    // reads should still name the action they ran.
    throw new Error('db-move: ' + err.message);
  }

  return {
    sql: call.sql,
    params: call.params,
    renameInJs: mapping.length ? mapping : null
  };
}

// Schema-qualified quoting moved to drivers/db/procedure.js with the rest of
// the call-building. Still used here for the table/query paths, so it is taken
// from there rather than kept as a second copy.
var quoteQualifiedIdent = procedureCall.quoteQualifiedIdent;

function normalizeMapping(columns) {
  return (columns || [])
    .filter(function(c) { return c && c.from; })
    .map(function(c) { return { from: c.from, to: c.to || c.from }; });
}

/** Dialect placeholder for bind param n (0-based). */
function placeholders(dbType) {
  if (dbType === 'mysql')  return function()  { return '?'; };
  if (dbType === 'mssql')  return function(n) { return '@p' + n; };
  return function(n) { return '$' + (n + 1); };   // postgres
}

/**
 * Rename keys on the way past — the procedure-only path.
 *
 * Columns NOT in the mapping are dropped rather than passed through: the
 * mapping is the statement of what the target has, and a stray column would
 * either fail the insert or silently widen the table on creation.
 */
async function* renamed(rows, mapping) {
  for await (var row of rows) {
    var out = {};
    for (var i = 0; i < mapping.length; i++) {
      out[mapping[i].to] = row[mapping[i].from];
    }
    yield out;
  }
}

/**
 * Empty the target, if it is there at all.
 *
 * TRUNCATE first, DELETE as the fallback: truncate is far cheaper but a
 * foreign key pointing at this table makes it illegal in every one of the
 * three dialects, and that is not a reason to fail the movement.
 */
async function truncateIfExists(driver, pool, table) {
  var existing = await driver.getTableSchema(pool, table);
  if (!existing || !existing.length) return false;
  try {
    await driver.query(pool, 'TRUNCATE TABLE ' + driver.quoteIdent(table), []);
  } catch (e) {
    await driver.query(pool, 'DELETE FROM ' + driver.quoteIdent(table), []);
  }
  return true;
}
