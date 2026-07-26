// Postgres driver — thin. SqlQueue owns retries + bisection + abort,
// so the driver just does: connect / query / close, and provides SQL
// builders the uploader composes into batch INSERT statements.
//
// Peer dep: pg (declared in @xeplr/actions/package.json as optional).
//
// Interface every db driver implements:
//
//   requires:                 ['pg']
//   async connect(config)                       → pool
//   async query(pool, sql, params?)             → { rows, rowCount, ... }
//   async close(pool)                           → void
//
//   buildCreateTableSql(tableName, columns, primaryKeys?)  → string
//   buildCreateErrorTableSql(tableName)                    → string
//   buildAlterTableAddSql(tableName, columns)              → string[]
//   buildInsertSql(tableName, rows, columns, movementId, primaryKeys?)
//                                                          → { sql, params }
//   async rollbackMovement(pool, tableName, movementId)    → { mainDeleted, errorDeleted }
//
// Type mapping — deliberately narrow to avoid width/precision footguns:
//   string  → TEXT
//   number  → NUMERIC          (integer + float both handled)
//   boolean → BOOLEAN
//   date    → TIMESTAMPTZ      (user rule: "always datetime, never date-only")
//   datetime→ TIMESTAMPTZ
//   object  → JSONB
//   array   → JSONB

var TYPE_MAP = {
  string:   'TEXT',
  number:   'NUMERIC',
  boolean:  'BOOLEAN',
  date:     'TIMESTAMPTZ',
  datetime: 'TIMESTAMPTZ',
  object:   'JSONB',
  array:    'JSONB'
};

// Framework-managed columns on every uploader-created table.
var INTERNAL_ID_COL       = '__xeplr_id__';
var INTERNAL_MOVEMENT_COL = '__xeplr_movement_id__';

async function connect(config) {
  var pg = require('pg');
  var pool = new pg.Pool({
    host:     config.host || 'localhost',
    port:     config.port || 5432,
    user:     config.user,
    password: config.password,
    database: config.database,
    max:      config.maxConnections || 10
  });
  return pool;
}

async function close(pool) {
  if (pool) await pool.end();
}

async function query(pool, sql, params) {
  return pool.query(sql, params || []);
}

function toPgType(type) { return TYPE_MAP[type] || 'TEXT'; }

// Double-quote a Postgres identifier, escaping embedded quotes.
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// Build the CREATE TABLE IF NOT EXISTS statement.
//   columns     — [{ name, type }]
//   primaryKeys — optional; realized as a UNIQUE INDEX (see buildUpsertIndexSql)
//                 so __xeplr_id__ stays the framework PK.
function buildCreateTableSql(tableName, columns, _primaryKeys) {
  var defs = [];
  defs.push(quoteIdent(INTERNAL_ID_COL)       + ' BIGSERIAL PRIMARY KEY');
  defs.push(quoteIdent(INTERNAL_MOVEMENT_COL) + ' TEXT NOT NULL');
  for (var i = 0; i < columns.length; i++) {
    var c = columns[i];
    defs.push(quoteIdent(c.name) + ' ' + toPgType(c.type));
  }
  return 'CREATE TABLE IF NOT EXISTS ' + quoteIdent(tableName) +
         ' (\n  ' + defs.join(',\n  ') + '\n)';
}

function buildCreateErrorTableSql(tableName) {
  var errTable = tableName + '_import_errors';
  return 'CREATE TABLE IF NOT EXISTS ' + quoteIdent(errTable) + ' (\n' +
    '  ' + quoteIdent(INTERNAL_ID_COL) + ' BIGSERIAL PRIMARY KEY,\n' +
    '  movement_id TEXT NOT NULL,\n' +
    '  row_num INTEGER,\n' +
    '  error_description TEXT,\n' +
    '  underlying_sql TEXT,\n' +
    '  raw_row JSONB,\n' +
    '  recorded_at TIMESTAMPTZ DEFAULT NOW()\n' +
    ')';
}

// Optional UNIQUE INDEX for UPSERT conflict-target when primaryKeys given.
function buildUpsertIndexSql(tableName, primaryKeys) {
  if (!primaryKeys || primaryKeys.length === 0) return null;
  var idxName = tableName + '_upsert_uniq';
  var cols = primaryKeys.map(quoteIdent).join(', ');
  return 'CREATE UNIQUE INDEX IF NOT EXISTS ' + quoteIdent(idxName) +
         ' ON ' + quoteIdent(tableName) + ' (' + cols + ')';
}

// One ALTER TABLE ADD COLUMN IF NOT EXISTS per new column — idempotent.
function buildAlterTableAddSql(tableName, columns) {
  return columns.map(function(c) {
    return 'ALTER TABLE ' + quoteIdent(tableName) +
           ' ADD COLUMN IF NOT EXISTS ' + quoteIdent(c.name) + ' ' + toPgType(c.type);
  });
}

// Bulk INSERT for a batch of rows. Emits parameterized SQL — values are
// never concatenated into the SQL string. Auto-adds __xeplr_movement_id__
// to every row. UPSERT if primaryKeys supplied.
function buildInsertSql(tableName, rows, columns, movementId, primaryKeys) {
  var colNames = columns.map(function(c) { return c.name; });
  var allCols  = [INTERNAL_MOVEMENT_COL].concat(colNames);

  var params = [];
  var groups = [];
  var idx = 1;

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var placeholders = ['$' + idx];
    params.push(movementId); idx++;
    for (var c = 0; c < colNames.length; c++) {
      placeholders.push('$' + idx);
      params.push(coerceValue(row[colNames[c]], columns[c].type));
      idx++;
    }
    groups.push('(' + placeholders.join(',') + ')');
  }

  var sql = 'INSERT INTO ' + quoteIdent(tableName) +
            ' (' + allCols.map(quoteIdent).join(', ') + ') VALUES ' + groups.join(',');

  if (primaryKeys && primaryKeys.length > 0) {
    // Non-PK user columns get updated. __xeplr_movement_id__ ALWAYS updates
    // on conflict — otherwise the latest movement can silently modify a row
    // it doesn't own on paper, and rollback would miss it.
    var updateCols = colNames.filter(function(c) { return primaryKeys.indexOf(c) === -1; });
    var setColumns = updateCols.concat([INTERNAL_MOVEMENT_COL]);
    var setClause = setColumns.map(function(c) {
      return quoteIdent(c) + ' = EXCLUDED.' + quoteIdent(c);
    }).join(', ');
    sql += ' ON CONFLICT (' + primaryKeys.map(quoteIdent).join(', ') +
           ') DO UPDATE SET ' + setClause;
  }

  return { sql: sql, params: params };
}

// Coerce a JS value to the target column's effective type. The uploader
// passes the RECONCILED column type here (target's type wins), so this
// function's job is to widen/narrow the JS value to fit.
//
// Failures aren't thrown — mismatched values (e.g. "abc" going into a
// number column) pass through unchanged, PG rejects them, and SqlQueue's
// bisection isolates the offending row into the error table.
function coerceValue(v, type) {
  if (v === undefined || v === null) return null;

  switch (type) {
    case 'string':
      // "String wins" widening: TEXT columns accept everything.
      if (v instanceof Date)         return v.toISOString();
      if (Array.isArray(v))          return JSON.stringify(v);
      if (typeof v === 'object')     return JSON.stringify(v);
      return String(v);

    case 'number':
      if (typeof v === 'number')     return v;
      if (typeof v === 'string') {
        var n = Number(v);
        return isNaN(n) ? v : n;     // non-numeric string → let PG reject
      }
      return v;

    case 'boolean':
      if (typeof v === 'boolean')    return v;
      if (typeof v === 'string') {
        var lower = v.toLowerCase().trim();
        if (lower === 'true'  || lower === '1' || lower === 'yes' || lower === 'y') return true;
        if (lower === 'false' || lower === '0' || lower === 'no'  || lower === 'n') return false;
      }
      if (typeof v === 'number')     return v !== 0;
      return v;                       // let PG reject

    case 'datetime':
      if (v instanceof Date)         return v.toISOString();
      return v;                       // strings pass through; PG parses

    case 'object':
    case 'array':
      if (typeof v === 'string') return v;   // assume valid JSON string
      return JSON.stringify(v);

    default:
      return v;
  }
}

// Native data_type → logical type, for reconcile. Shared with the reconcile
// module so the mapping lives in one place; exposed here so the uploader can
// call driver.dataTypeToLogical uniformly across all dialects.
var pgDataTypeToLogical = require('../../uploader/reconcile').pgDataTypeToLogical;
function dataTypeToLogical(dataType) { return pgDataTypeToLogical(dataType); }

// Idempotently ensure __xeplr_movement_id__ exists on a (possibly pre-existing)
// target table. Same operation the uploader used to inline; kept here so every
// driver exposes the same async ensure interface.
async function ensureMovementColumn(pool, tableName) {
  await pool.query(
    'ALTER TABLE ' + quoteIdent(tableName) +
    ' ADD COLUMN IF NOT EXISTS ' + quoteIdent(INTERNAL_MOVEMENT_COL) + ' TEXT'
  );
}

// Idempotently ensure the UNIQUE index that backs ON CONFLICT.
async function ensureUpsertIndex(pool, tableName, primaryKeys) {
  var sql = buildUpsertIndexSql(tableName, primaryKeys);
  if (sql) await pool.query(sql);
}

// Query the target table's actual column set. Returns [{name, dataType, udtName}]
// in ordinal-position order. Empty array if the table doesn't exist.
async function getTableSchema(pool, tableName, schema) {
  var r = await pool.query(
    "SELECT column_name, data_type, udt_name " +
    "FROM information_schema.columns " +
    "WHERE table_schema = $2 AND table_name = $1 " +
    "ORDER BY ordinal_position",
    [tableName, schema || 'public']
  );
  return r.rows.map(function(row) {
    return { name: row.column_name, dataType: row.data_type, udtName: row.udt_name };
  });
}

// Table/view/procedure listing — used by the db-list-* actions. All three
// default to the 'public' schema (Postgres's default search_path entry),
// same fallback getTableSchema already uses.
async function listTables(pool, schema) {
  var r = await pool.query(
    "SELECT table_name FROM information_schema.tables " +
    "WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
    [schema || 'public']
  );
  return r.rows.map(function(row) { return row.table_name; });
}

async function listViews(pool, schema) {
  var r = await pool.query(
    "SELECT table_name FROM information_schema.views " +
    "WHERE table_schema = $1 ORDER BY table_name",
    [schema || 'public']
  );
  return r.rows.map(function(row) { return row.table_name; });
}

// routine_type='PROCEDURE' only (true CREATE PROCEDURE, PG11+) — deliberately
// excludes FUNCTION so this lines up with what "procedures" means on the
// other two dialects, which have no separate function/procedure distinction
// in this listing.
async function listProcedures(pool, schema) {
  var r = await pool.query(
    "SELECT routine_name FROM information_schema.routines " +
    "WHERE routine_schema = $1 AND routine_type = 'PROCEDURE' ORDER BY routine_name",
    [schema || 'public']
  );
  return r.rows.map(function(row) { return row.routine_name; });
}

// Stream a result set WITHOUT buffering it in memory — the read primitive
// db-fetch composes. Uses a server-side cursor (DECLARE/FETCH) on a dedicated
// checked-out client, so PG holds the result set and we pull it `batchSize`
// rows at a time. The async generator naturally applies backpressure: the next
// FETCH only fires when the consumer asks for more.
//
//   opts: { sql, params?, batchSize? }  →  async iterable<row>
async function* fetchStream(pool, opts) {
  var batchSize = Math.max(1, parseInt(opts.batchSize || 1000, 10));
  var client = await pool.connect();
  var declared = false;
  try {
    await client.query('BEGIN');
    await client.query('DECLARE __xeplr_fetch_cur NO SCROLL CURSOR FOR ' + opts.sql, opts.params || []);
    declared = true;
    while (true) {
      var res = await client.query('FETCH FORWARD ' + batchSize + ' FROM __xeplr_fetch_cur');
      if (res.rows.length === 0) break;
      for (var i = 0; i < res.rows.length; i++) yield res.rows[i];
    }
  } finally {
    try { if (declared) await client.query('CLOSE __xeplr_fetch_cur'); } catch (_) {}
    try { await client.query('COMMIT'); } catch (_) {}
    client.release();
  }
}

// Delete all rows for a movement across main + error tables.
// Error table might not exist yet (movement failed before first batch) —
// swallow those errors silently.
async function rollbackMovement(pool, tableName, movementId) {
  var errTable = tableName + '_import_errors';
  var result = { mainDeleted: 0, errorDeleted: 0 };

  var r1 = await pool.query(
    'DELETE FROM ' + quoteIdent(tableName) +
    ' WHERE ' + quoteIdent(INTERNAL_MOVEMENT_COL) + ' = $1',
    [movementId]
  );
  result.mainDeleted = r1.rowCount || 0;

  try {
    var r2 = await pool.query(
      'DELETE FROM ' + quoteIdent(errTable) + ' WHERE movement_id = $1',
      [movementId]
    );
    result.errorDeleted = r2.rowCount || 0;
  } catch (err) {
    if (err.code !== '42P01') throw err;   // 42P01 = relation does not exist
  }

  return result;
}

module.exports = {
  requires: ['pg'],

  // Connection lifecycle
  connect: connect,
  query:   query,
  close:   close,

  // SQL builders (called by uploader — pure functions, no DB access)
  toPgType:                toPgType,
  dataTypeToLogical:       dataTypeToLogical,
  quoteIdent:              quoteIdent,
  buildCreateTableSql:     buildCreateTableSql,
  buildCreateErrorTableSql:buildCreateErrorTableSql,
  buildUpsertIndexSql:     buildUpsertIndexSql,
  buildAlterTableAddSql:   buildAlterTableAddSql,
  buildInsertSql:          buildInsertSql,

  // Idempotent DDL helpers (async — uniform across all dialect drivers)
  ensureMovementColumn: ensureMovementColumn,
  ensureUpsertIndex:    ensureUpsertIndex,

  // Introspection (used by uploader.reconcile + the db-list-* actions)
  getTableSchema:  getTableSchema,
  listTables:      listTables,
  listViews:       listViews,
  listProcedures:  listProcedures,

  // Streaming read primitive (used by db-fetch)
  fetchStream: fetchStream,

  // Rollback helper
  rollbackMovement: rollbackMovement,

  // Constants
  INTERNAL_ID_COL:       INTERNAL_ID_COL,
  INTERNAL_MOVEMENT_COL: INTERNAL_MOVEMENT_COL
};
