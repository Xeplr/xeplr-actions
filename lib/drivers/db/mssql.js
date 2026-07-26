// MS SQL Server driver — parity with db/postgres.js. SqlQueue owns retries +
// bisection + abort, so the driver just does connect / query / close and
// provides the SQL builders the uploader composes into batch INSERTs.
//
// Peer dep: mssql (declared optional in @xeplr/actions/package.json).
//
// Dialect differences from Postgres worth calling out:
//   • Placeholders are named `@p0, @p1, …` (0-based, matching the order
//     buildInsertSql pushes params). query() binds them via request.input.
//   • Identifiers are bracket-quoted: [name] (embedded ] doubled).
//   • No `CREATE TABLE IF NOT EXISTS` / `IF NOT EXISTS` on index/column, so we
//     guard with `IF OBJECT_ID(...) IS NULL` / `IF COL_LENGTH(...) IS NULL` /
//     `IF NOT EXISTS (SELECT … sys.indexes …)` — all single-batch statements.
//   • The mssql package returns `{ recordset, rowsAffected }` — query()
//     normalizes it to the Postgres-shaped `{ rows, rowCount }`.
//   • HARD LIMIT: SQL Server allows max 2100 parameters per statement AND max
//     1000 rows per multi-row VALUES. maxParams=2000 keeps BOTH satisfied
//     (worst case: 1 user col → 2 params/row → 1000 rows).
//
// Type mapping — deliberately narrow, mirroring the Postgres driver's intent:
//   string  → NVARCHAR(MAX)
//   number  → DECIMAL(38,10)   (38 is SQL Server's max precision; > 10
//                               fractional digits are rounded)
//   boolean → BIT
//   date    → DATETIME2        (user rule: always datetime, stored UTC)
//   datetime→ DATETIME2
//   object  → NVARCHAR(MAX)    (SQL Server has no native JSON type)
//   array   → NVARCHAR(MAX)

var TYPE_MAP = {
  string:   'NVARCHAR(MAX)',
  number:   'DECIMAL(38,10)',
  boolean:  'BIT',
  date:     'DATETIME2',
  datetime: 'DATETIME2',
  object:   'NVARCHAR(MAX)',
  array:    'NVARCHAR(MAX)'
};

// INFORMATION_SCHEMA DATA_TYPE (lowercase) → our logical types, for reconcile.
var NATIVE_TO_LOGICAL = {
  varchar: 'string', nvarchar: 'string', char: 'string', nchar: 'string',
  text: 'string', ntext: 'string', uniqueidentifier: 'string', xml: 'string',
  int: 'number', bigint: 'number', smallint: 'number', tinyint: 'number',
  decimal: 'number', numeric: 'number', float: 'number', real: 'number',
  money: 'number', smallmoney: 'number',
  bit: 'boolean',
  datetime: 'datetime', datetime2: 'datetime', smalldatetime: 'datetime',
  date: 'datetime', time: 'datetime', datetimeoffset: 'datetime'
};

var INTERNAL_ID_COL       = '__xeplr_id__';
var INTERNAL_MOVEMENT_COL = '__xeplr_movement_id__';

// See header note — 2000 satisfies both the 2100-param and 1000-row caps.
var MAX_PARAMS = 2000;

async function connect(config) {
  var sql = require('mssql');
  var pool = new sql.ConnectionPool({
    server:   config.host || config.server || 'localhost',
    port:     config.port || 1433,
    user:     config.user,
    password: config.password,
    database: config.database,
    pool:     { max: config.maxConnections || 10 },
    options:  Object.assign(
      { encrypt: true, trustServerCertificate: true },
      config.options || {}
    )
  });
  await pool.connect();
  return pool;
}

async function close(pool) {
  if (pool) await pool.close();
}

// Bind params as @p0..@pN and normalize `{ recordset, rowsAffected }` to
// Postgres shape. NOTE: mssql infers the SQL type from each JS value; a null
// with no sibling non-null value in the batch falls back to NVARCHAR, which is
// fine for our INSERTs since the column type is already declared.
async function query(pool, sql, params) {
  var request = pool.request();
  params = params || [];
  for (var i = 0; i < params.length; i++) {
    request.input('p' + i, params[i]);
  }
  var r = await request.query(sql);
  var rows = r.recordset || [];
  var rowCount = Array.isArray(r.rowsAffected)
    ? r.rowsAffected.reduce(function(a, b) { return a + b; }, 0)
    : rows.length;
  return { rows: rows, rowCount: rowCount };
}

function toMssqlType(type) { return TYPE_MAP[type] || 'NVARCHAR(MAX)'; }

function dataTypeToLogical(dataType) {
  return NATIVE_TO_LOGICAL[String(dataType).toLowerCase()] || 'string';
}

// Bracket-quote a SQL Server identifier, escaping embedded closing brackets.
function quoteIdent(name) {
  return '[' + String(name).replace(/]/g, ']]') + ']';
}

// A string literal for use inside OBJECT_ID(N'…') / COL_LENGTH — single quotes
// doubled. NOT for values (those are always parameterized).
function quoteLiteral(s) {
  return "N'" + String(s).replace(/'/g, "''") + "'";
}

function buildCreateTableSql(tableName, columns, primaryKeys) {
  var defs = [];
  defs.push(quoteIdent(INTERNAL_ID_COL)       + ' BIGINT IDENTITY(1,1) PRIMARY KEY');
  defs.push(quoteIdent(INTERNAL_MOVEMENT_COL) + ' NVARCHAR(255) NOT NULL');
  for (var i = 0; i < columns.length; i++) {
    defs.push(quoteIdent(columns[i].name) + ' ' + columnDef(columns[i], primaryKeys));
  }
  return 'IF OBJECT_ID(' + quoteLiteral(tableName) + ", 'U') IS NULL\n" +
         'CREATE TABLE ' + quoteIdent(tableName) +
         ' (\n  ' + defs.join(',\n  ') + '\n)';
}

// A string PK column can't be NVARCHAR(MAX) — SQL Server rejects LOB types as
// index key columns. UPSERT's MERGE needs a UNIQUE index on the PK cols, so
// bound PK string columns to NVARCHAR(255) (510 bytes; composite keys stay
// under the nonclustered-index key limit). Pre-create the table with a wider
// bounded NVARCHAR if your keys are longer.
function columnDef(col, primaryKeys) {
  if (col.type === 'string' && primaryKeys && primaryKeys.indexOf(col.name) !== -1) {
    return 'NVARCHAR(255)';
  }
  return toMssqlType(col.type);
}

function buildCreateErrorTableSql(tableName) {
  var errTable = tableName + '_import_errors';
  return 'IF OBJECT_ID(' + quoteLiteral(errTable) + ", 'U') IS NULL\n" +
    'CREATE TABLE ' + quoteIdent(errTable) + ' (\n' +
    '  ' + quoteIdent(INTERNAL_ID_COL) + ' BIGINT IDENTITY(1,1) PRIMARY KEY,\n' +
    '  movement_id NVARCHAR(255) NOT NULL,\n' +
    '  row_num INT,\n' +
    '  error_description NVARCHAR(MAX),\n' +
    '  underlying_sql NVARCHAR(MAX),\n' +
    '  raw_row NVARCHAR(MAX),\n' +
    '  recorded_at DATETIME2 DEFAULT SYSUTCDATETIME()\n' +
    ')';
}

// One guarded `ALTER TABLE ADD` per column — idempotent via COL_LENGTH.
// (SQL Server uses `ADD`, not `ADD COLUMN`.)
function buildAlterTableAddSql(tableName, columns) {
  return columns.map(function(c) {
    return 'IF COL_LENGTH(' + quoteLiteral(tableName) + ', ' + quoteLiteral(c.name) + ') IS NULL\n' +
           'ALTER TABLE ' + quoteIdent(tableName) +
           ' ADD ' + quoteIdent(c.name) + ' ' + toMssqlType(c.type);
  });
}

// Bulk INSERT (UPSERT via MERGE when primaryKeys given). Parameterized with
// @p0..@pN; values never concatenated into SQL.
function buildInsertSql(tableName, rows, columns, movementId, primaryKeys) {
  var colNames = columns.map(function(c) { return c.name; });
  var allCols  = [INTERNAL_MOVEMENT_COL].concat(colNames);

  var params = [];
  var groups = [];
  var idx = 0;

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var placeholders = ['@p' + idx];
    params.push(movementId); idx++;
    for (var c = 0; c < colNames.length; c++) {
      placeholders.push('@p' + idx);
      params.push(coerceValue(row[colNames[c]], columns[c].type));
      idx++;
    }
    groups.push('(' + placeholders.join(',') + ')');
  }

  var quotedCols = allCols.map(quoteIdent);

  if (primaryKeys && primaryKeys.length > 0) {
    return { sql: buildMergeSql(tableName, quotedCols, colNames, groups, primaryKeys), params: params };
  }

  var sql = 'INSERT INTO ' + quoteIdent(tableName) +
            ' (' + quotedCols.join(', ') + ') VALUES ' + groups.join(',');
  return { sql: sql, params: params };
}

// UPSERT for SQL Server. There is no ON CONFLICT / ON DUPLICATE KEY — MERGE is
// the portable primitive. Source rows come from a VALUES table constructor.
function buildMergeSql(tableName, quotedCols, colNames, valueGroups, primaryKeys) {
  var target = quoteIdent(tableName);
  var srcCols = quotedCols.join(', ');

  var onClause = primaryKeys.map(function(pk) {
    return 'T.' + quoteIdent(pk) + ' = S.' + quoteIdent(pk);
  }).join(' AND ');

  // Non-PK user columns update on match. __xeplr_movement_id__ ALWAYS updates
  // so the latest movement "owns" the row and rollback finds it.
  var updateCols = colNames.filter(function(c) { return primaryKeys.indexOf(c) === -1; });
  var setColumns = updateCols.concat([INTERNAL_MOVEMENT_COL]);
  var setClause = setColumns.map(function(c) {
    return 'T.' + quoteIdent(c) + ' = S.' + quoteIdent(c);
  }).join(', ');

  var insertCols = quotedCols.join(', ');
  var insertVals = quotedCols.map(function(c) { return 'S.' + c; }).join(', ');

  var sql =
    'MERGE INTO ' + target + ' AS T\n' +
    'USING (VALUES ' + valueGroups.join(',') + ') AS S (' + srcCols + ')\n' +
    'ON ' + onClause + '\n' +
    (setClause ? 'WHEN MATCHED THEN UPDATE SET ' + setClause + '\n' : '') +
    'WHEN NOT MATCHED THEN INSERT (' + insertCols + ') VALUES (' + insertVals + ')\n' +
    ';';   // MERGE must be terminated with a semicolon
  return sql;
}

// Coerce a JS value to the target column's effective type. Mirrors the
// Postgres driver; datetime is emitted as a UTC string (DATETIME2 parses ISO
// without the trailing Z). Bad values pass through so SQL Server rejects them
// and SqlQueue bisects the row into the error table.
function coerceValue(v, type) {
  if (v === undefined || v === null) return null;

  switch (type) {
    case 'string':
      if (v instanceof Date)     return toMssqlDatetime(v);
      if (Array.isArray(v))      return JSON.stringify(v);
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);

    case 'number':
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        var n = Number(v);
        return isNaN(n) ? v : n;   // non-numeric string → let SQL Server reject
      }
      return v;

    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        var lower = v.toLowerCase().trim();
        if (lower === 'true'  || lower === '1' || lower === 'yes' || lower === 'y') return true;
        if (lower === 'false' || lower === '0' || lower === 'no'  || lower === 'n') return false;
      }
      if (typeof v === 'number')  return v !== 0;
      return v;                    // let SQL Server reject

    case 'date':
    case 'datetime':
      return toMssqlDatetime(v);

    case 'object':
    case 'array':
      if (typeof v === 'string') return v;   // assume valid JSON string
      return JSON.stringify(v);

    default:
      return v;
  }
}

// 'YYYY-MM-DD HH:MM:SS.mmm' in UTC — DATETIME2 parses this unambiguously.
// Unparseable input passes through so SQL Server rejects it (→ error table).
function toMssqlDatetime(v) {
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

async function getTableSchema(pool, tableName, schema) {
  var r = await query(pool,
    'SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType ' +
    'FROM INFORMATION_SCHEMA.COLUMNS ' +
    'WHERE TABLE_NAME = @p0 AND (@p1 IS NULL OR TABLE_SCHEMA = @p1) ' +
    'ORDER BY ORDINAL_POSITION',
    [tableName, schema || null]
  );
  return r.rows.map(function(row) {
    return { name: row.name, dataType: row.dataType, udtName: row.dataType };
  });
}

// Table/view/procedure listing — used by the db-list-* actions. A null/omitted
// `schema` returns every schema's objects (no dbo-only default) — SQL Server
// databases commonly spread real tables across several schemas, unlike
// Postgres/MySQL where a single default schema is the normal case.
async function listTables(pool, schema) {
  var r = await query(pool,
    'SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES ' +
    "WHERE TABLE_TYPE = 'BASE TABLE' AND (@p0 IS NULL OR TABLE_SCHEMA = @p0) " +
    'ORDER BY TABLE_NAME',
    [schema || null]
  );
  return r.rows.map(function(row) { return row.name; });
}

async function listViews(pool, schema) {
  var r = await query(pool,
    'SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES ' +
    "WHERE TABLE_TYPE = 'VIEW' AND (@p0 IS NULL OR TABLE_SCHEMA = @p0) " +
    'ORDER BY TABLE_NAME',
    [schema || null]
  );
  return r.rows.map(function(row) { return row.name; });
}

// ROUTINE_TYPE='PROCEDURE' only — excludes FUNCTION, same reasoning as the
// Postgres driver's listProcedures.
async function listProcedures(pool, schema) {
  var r = await query(pool,
    'SELECT ROUTINE_NAME AS name FROM INFORMATION_SCHEMA.ROUTINES ' +
    "WHERE ROUTINE_TYPE = 'PROCEDURE' AND (@p0 IS NULL OR ROUTINE_SCHEMA = @p0) " +
    'ORDER BY ROUTINE_NAME',
    [schema || null]
  );
  return r.rows.map(function(row) { return row.name; });
}

// Idempotently ensure __xeplr_movement_id__ exists (guarded single statement).
async function ensureMovementColumn(pool, tableName) {
  await query(pool,
    'IF COL_LENGTH(@p0, @p1) IS NULL\n' +
    'ALTER TABLE ' + quoteIdent(tableName) +
    ' ADD ' + quoteIdent(INTERNAL_MOVEMENT_COL) + ' NVARCHAR(255)',
    [tableName, INTERNAL_MOVEMENT_COL]
  );
}

// Idempotently ensure the UNIQUE index that backs the MERGE match.
async function ensureUpsertIndex(pool, tableName, primaryKeys) {
  if (!primaryKeys || primaryKeys.length === 0) return;
  var idxName = tableName + '_upsert_uniq';
  var cols = primaryKeys.map(quoteIdent).join(', ');
  await query(pool,
    'IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = @p0 AND object_id = OBJECT_ID(@p1))\n' +
    'CREATE UNIQUE INDEX ' + quoteIdent(idxName) +
    ' ON ' + quoteIdent(tableName) + ' (' + cols + ')',
    [idxName, tableName]
  );
}

// Stream a result set WITHOUT buffering it in memory — the read primitive
// db-fetch composes. The mssql package streams via events (`row`/`error`/
// `done`) rather than a Node Readable, so we bridge those to an async iterator
// with real backpressure: pause the request once `batchSize` rows are buffered,
// resume after the consumer drains them.
//
//   opts: { sql, params?, batchSize? }  →  async iterable<row>
async function* fetchStream(pool, opts) {
  var high = Math.max(1, parseInt(opts.batchSize || 1000, 10));
  var request = pool.request();
  var params = opts.params || [];
  for (var i = 0; i < params.length; i++) request.input('p' + i, params[i]);
  request.stream = true;

  var buffer = [];
  var done = false;
  var error = null;
  var paused = false;
  var wake = null;                       // resolver for the consumer's wait

  function signal() { if (wake) { var w = wake; wake = null; w(); } }

  request.on('row', function(row) {
    buffer.push(row);
    if (buffer.length >= high && !paused) { paused = true; request.pause(); }
    signal();
  });
  request.on('error', function(err) { error = err; signal(); });
  request.on('done',  function()    { done = true;  signal(); });

  // Fire the query — with stream=true this drives the events above. We don't
  // await the returned promise; the events are the source of truth.
  request.query(opts.sql).catch(function(err) { error = error || err; signal(); });

  try {
    while (true) {
      if (buffer.length) {
        var batch = buffer;
        buffer = [];
        if (paused) { paused = false; request.resume(); }
        for (var j = 0; j < batch.length; j++) yield batch[j];
        continue;
      }
      if (error) throw error;
      if (done) return;
      await new Promise(function(res) { wake = res; });
    }
  } finally {
    // If the consumer breaks out early, stop the underlying request.
    if (!done && !error) { try { request.cancel(); } catch (_) {} }
  }
}

async function rollbackMovement(pool, tableName, movementId) {
  var errTable = tableName + '_import_errors';
  var result = { mainDeleted: 0, errorDeleted: 0 };

  var r1 = await query(pool,
    'DELETE FROM ' + quoteIdent(tableName) +
    ' WHERE ' + quoteIdent(INTERNAL_MOVEMENT_COL) + ' = @p0',
    [movementId]
  );
  result.mainDeleted = r1.rowCount || 0;

  // Error table might not exist yet — guard with OBJECT_ID so a missing table
  // is a no-op rather than an error (parity with PG's 42P01 swallow).
  var r2 = await query(pool,
    'IF OBJECT_ID(' + quoteLiteral(errTable) + ", 'U') IS NOT NULL\n" +
    'DELETE FROM ' + quoteIdent(errTable) + ' WHERE movement_id = @p0',
    [movementId]
  );
  result.errorDeleted = r2.rowCount || 0;

  return result;
}

module.exports = {
  requires: ['mssql'],
  maxParams: MAX_PARAMS,

  // Connection lifecycle
  connect: connect,
  query:   query,
  close:   close,

  // SQL builders (pure functions, no DB access)
  toMssqlType:              toMssqlType,
  dataTypeToLogical:        dataTypeToLogical,
  quoteIdent:               quoteIdent,
  buildCreateTableSql:      buildCreateTableSql,
  buildCreateErrorTableSql: buildCreateErrorTableSql,
  buildAlterTableAddSql:    buildAlterTableAddSql,
  buildInsertSql:           buildInsertSql,

  // Idempotent DDL helpers (async — guarded single-batch statements)
  ensureMovementColumn: ensureMovementColumn,
  ensureUpsertIndex:    ensureUpsertIndex,

  // Streaming read primitive (used by db-fetch)
  fetchStream: fetchStream,

  // Introspection (used by uploader.reconcile + the db-list-* actions) + rollback
  getTableSchema:   getTableSchema,
  listTables:       listTables,
  listViews:        listViews,
  listProcedures:   listProcedures,
  rollbackMovement: rollbackMovement,

  // Constants
  INTERNAL_ID_COL:       INTERNAL_ID_COL,
  INTERNAL_MOVEMENT_COL: INTERNAL_MOVEMENT_COL
};
