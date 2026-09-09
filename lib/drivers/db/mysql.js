// MySQL / MariaDB driver — parity with db/postgres.js. SqlQueue owns retries
// + bisection + abort, so the driver just does connect / query / close and
// provides the SQL builders the uploader composes into batch INSERTs.
//
// Peer dep: mysql2 (declared optional in @xeplr/actions/package.json).
//
// Dialect differences from Postgres worth calling out:
//   • Placeholders are positional `?` (not `$1`).
//   • Identifiers are backtick-quoted (not double-quoted).
//   • MySQL 8 has NO `ADD COLUMN IF NOT EXISTS` and NO `CREATE INDEX IF NOT
//     EXISTS`, so ensureMovementColumn / ensureUpsertIndex introspect
//     information_schema first, then run the DDL only if absent.
//   • mysql2's pool.query resolves to `[rows]` — query() normalizes it to the
//     Postgres-shaped `{ rows, rowCount }` so the rest of the framework is
//     dialect-agnostic.
//
// Type mapping — deliberately narrow, mirroring the Postgres driver's intent:
//   string  → LONGTEXT
//   number  → DECIMAL(38,10)   (exact; > 10 fractional digits are rounded —
//                               pre-create a wider column if you need more)
//   boolean → TINYINT(1)
//   date    → DATETIME(6)      (user rule: always datetime, stored UTC)
//   datetime→ DATETIME(6)
//   object  → JSON
//   array   → JSON

var TYPE_MAP = {
  string:   'LONGTEXT',
  number:   'DECIMAL(38,10)',
  boolean:  'TINYINT(1)',
  date:     'DATE',
  datetime: 'DATETIME(6)',
  object:   'JSON',
  array:    'JSON'
};

// information_schema DATA_TYPE (lowercase) → our logical types, for reconcile.
var NATIVE_TO_LOGICAL = {
  varchar: 'string', char: 'string', text: 'string', tinytext: 'string',
  mediumtext: 'string', longtext: 'string', enum: 'string', set: 'string',
  int: 'number', integer: 'number', bigint: 'number', smallint: 'number',
  mediumint: 'number', tinyint: 'number', decimal: 'number', numeric: 'number',
  float: 'number', double: 'number', bit: 'boolean',
  // 'date' maps to its OWN logical type — see reconcile.js. A DATE column
  // created as DATETIME acquires a midnight that shifts under a timezone.
  date: 'date', datetime: 'datetime', timestamp: 'datetime',
  time: 'datetime', year: 'datetime',
  json: 'object'
};


// A calendar date, as YYYY-MM-DD, with NO timezone conversion.
//
// toISOString() would convert to UTC first, which is exactly the bug: a Date
// holding 2026-01-05 local becomes 2026-01-04 in UTC anywhere east of
// Greenwich. The local getters are the right ones here precisely because a
// business date has no instant to convert.
function toDateOnly(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.getFullYear() + '-' +
      String(v.getMonth() + 1).padStart(2, '0') + '-' +
      String(v.getDate()).padStart(2, '0');
  }
  // Already a date string — take the date part and leave the rest alone.
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : v;
}

var INTERNAL_ID_COL       = '__xeplr_id__';
var INTERNAL_MOVEMENT_COL = '__xeplr_movement_id__';

// MySQL's max placeholders per prepared statement is 65,535 — same ceiling as
// PG. Stay comfortably under it; the uploader divides by params-per-row.
var MAX_PARAMS = 60000;

async function connect(config) {
  var mysql = require('mysql2/promise');
  // timezone:'Z' makes mysql2 read/write DATETIME as UTC, matching how
  // coerceValue serializes datetimes. dateStrings avoids local-tz Date shifts.
  var pool = mysql.createPool({
    host:              config.host || 'localhost',
    port:              config.port || 3306,
    user:              config.user,
    password:          config.password,
    database:          config.database,
    connectionLimit:   config.maxConnections || 10,
    timezone:          'Z',
    dateStrings:       true,
    supportBigNumbers: true,
    bigNumberStrings:  true
  });
  return pool;
}

async function close(pool) {
  if (pool) await pool.end();
}

// Normalize mysql2's `[rows|ResultSetHeader, fields]` to Postgres shape.
//
// The second element is the field list, which mysql2 returns even for a
// SELECT that matched nothing — so `columns` describes the result's shape
// when there is not a single row to infer it from.
async function query(pool, sql, params) {
  var res = await pool.query(sql, params || []);
  var out = res[0];
  var fields = res[1];

  // A CALL ANSWERS WITH MULTIPLE RESULT SETS, and that is not an edge case —
  // it is what every stored procedure that SELECTs does. mysql2 returns
  // `[ [rows], OkPacket ]` for one, so `out` is an array whose first element
  // is itself an array, and `fields` is `[ [fields], undefined ]`.
  //
  // Read as a plain SELECT that produced: rows = [ [ {...} ], OkPacket ] — a
  // result set wrapped in another one — and columns mapped `f.name` over that
  // undefined second entry, which threw "Cannot read properties of undefined
  // (reading 'name')". So a procedure returning rows failed on MySQL with an
  // error naming nothing to do with procedures. Nothing hit it before because
  // nothing could call one: db-move's procedure mode is only exercised against
  // mssql/postgres in practice, and there was no other caller.
  //
  // THE FIRST result set is the answer. A procedure that SELECTs twice is
  // telling the caller two things and this action's shape has room for one;
  // taking the first is the same rule every client library applies, rather
  // than concatenating rows of different widths into one nonsense list.
  if (Array.isArray(out) && out.length && Array.isArray(out[0])) {
    var rows = out[0];
    var firstFields = (Array.isArray(fields) && fields[0]) || [];
    return {
      rows: rows,
      rowCount: rows.length,
      columns: firstFields.map(function(f) { return f.name; })
    };
  }

  var columns = (fields || []).map(function(f) { return f.name; });
  if (Array.isArray(out)) {
    return { rows: out, rowCount: out.length, columns: columns };   // SELECT
  }
  // DML, and a CALL whose procedure returns nothing at all — both answer with
  // an OkPacket rather than a result set.
  return { rows: [], rowCount: (out && out.affectedRows) || 0, columns: [] };
}

function toMysqlType(type) { return TYPE_MAP[type] || 'LONGTEXT'; }

function dataTypeToLogical(dataType) {
  return NATIVE_TO_LOGICAL[String(dataType).toLowerCase()] || 'string';
}

// Backtick-quote a MySQL identifier, escaping embedded backticks.
function quoteIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function buildCreateTableSql(tableName, columns, primaryKeys) {
  var defs = [];
  defs.push(quoteIdent(INTERNAL_ID_COL)       + ' BIGINT AUTO_INCREMENT PRIMARY KEY');
  defs.push(quoteIdent(INTERNAL_MOVEMENT_COL) + ' VARCHAR(255) NOT NULL');
  for (var i = 0; i < columns.length; i++) {
    defs.push(quoteIdent(columns[i].name) + ' ' + columnDef(columns[i], primaryKeys));
  }
  return 'CREATE TABLE IF NOT EXISTS ' + quoteIdent(tableName) +
         ' (\n  ' + defs.join(',\n  ') + '\n)';
}

// A string PK column can't be LONGTEXT — MySQL rejects TEXT/BLOB in an index
// key without a prefix length. UPSERT needs a UNIQUE index on the PK cols, so
// bound PK string columns to VARCHAR(255) (indexable; 255 utf8mb4 chars keeps
// composite keys under InnoDB's 3072-byte prefix limit). Pre-create the table
// with a wider bounded VARCHAR if your keys are longer.
function columnDef(col, primaryKeys) {
  if (col.type === 'string' && primaryKeys && primaryKeys.indexOf(col.name) !== -1) {
    return 'VARCHAR(255)';
  }
  return toMysqlType(col.type);
}

function buildCreateErrorTableSql(tableName) {
  var errTable = tableName + '_import_errors';
  return 'CREATE TABLE IF NOT EXISTS ' + quoteIdent(errTable) + ' (\n' +
    '  ' + quoteIdent(INTERNAL_ID_COL) + ' BIGINT AUTO_INCREMENT PRIMARY KEY,\n' +
    '  movement_id VARCHAR(255) NOT NULL,\n' +
    '  row_num INT,\n' +
    '  error_description LONGTEXT,\n' +
    '  underlying_sql LONGTEXT,\n' +
    '  raw_row JSON,\n' +
    '  recorded_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)\n' +
    ')';
}

// One plain `ALTER TABLE ADD COLUMN` per column. NOT idempotent (MySQL 8 has
// no IF NOT EXISTS for ADD COLUMN) — for idempotent movement-column handling
// use ensureMovementColumn().
function buildAlterTableAddSql(tableName, columns) {
  return columns.map(function(c) {
    return 'ALTER TABLE ' + quoteIdent(tableName) +
           ' ADD COLUMN ' + quoteIdent(c.name) + ' ' + toMysqlType(c.type);
  });
}

// Bulk INSERT (UPSERT via ON DUPLICATE KEY UPDATE when primaryKeys given).
// Parameterized with `?`; values never concatenated into SQL.
function buildInsertSql(tableName, rows, columns, movementId, primaryKeys) {
  var colNames = columns.map(function(c) { return c.name; });
  var allCols  = [INTERNAL_MOVEMENT_COL].concat(colNames);

  var params = [];
  var groups = [];

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var placeholders = ['?'];
    params.push(movementId);
    for (var c = 0; c < colNames.length; c++) {
      placeholders.push('?');
      params.push(coerceValue(row[colNames[c]], columns[c].type));
    }
    groups.push('(' + placeholders.join(',') + ')');
  }

  var sql = 'INSERT INTO ' + quoteIdent(tableName) +
            ' (' + allCols.map(quoteIdent).join(', ') + ') VALUES ' + groups.join(',');

  if (primaryKeys && primaryKeys.length > 0) {
    // Non-PK user columns update on conflict. __xeplr_movement_id__ ALWAYS
    // updates so the latest movement "owns" the row and rollback finds it.
    // VALUES() is deprecated in MySQL 8.0.20+ but has the widest version
    // support across MySQL 5.7 / 8 / MariaDB — keep it for portability.
    var updateCols = colNames.filter(function(c) { return primaryKeys.indexOf(c) === -1; });
    var setColumns = updateCols.concat([INTERNAL_MOVEMENT_COL]);
    var setClause = setColumns.map(function(c) {
      return quoteIdent(c) + ' = VALUES(' + quoteIdent(c) + ')';
    }).join(', ');
    sql += ' ON DUPLICATE KEY UPDATE ' + setClause;
  }

  return { sql: sql, params: params };
}

// Coerce a JS value to the target column's effective type. Mirrors the
// Postgres driver; the only dialect divergence is datetime (UTC string) and
// boolean (0|1). Bad values pass through so MySQL rejects them and SqlQueue
// bisects the row into the error table.
function coerceValue(v, type) {
  if (v === undefined || v === null) return null;

  switch (type) {
    case 'string':
      if (v instanceof Date)     return toMysqlDatetime(v);
      if (Array.isArray(v))      return JSON.stringify(v);
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);

    case 'number':
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        var n = Number(v);
        return isNaN(n) ? v : n;   // non-numeric string → let MySQL reject
      }
      return v;

    case 'boolean':
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'string') {
        var lower = v.toLowerCase().trim();
        if (lower === 'true'  || lower === '1' || lower === 'yes' || lower === 'y') return 1;
        if (lower === 'false' || lower === '0' || lower === 'no'  || lower === 'n') return 0;
      }
      if (typeof v === 'number')  return v !== 0 ? 1 : 0;
      return v;                    // let MySQL reject

    case 'date':
      return toDateOnly(v);

    case 'datetime':
      return toMysqlDatetime(v);

    case 'object':
    case 'array':
      if (typeof v === 'string') return v;   // assume valid JSON string
      return JSON.stringify(v);

    default:
      return v;
  }
}

// 'YYYY-MM-DD HH:MM:SS.mmm' in UTC — the format MySQL DATETIME accepts.
// Unparseable input passes through so MySQL rejects it (→ error table).
function toMysqlDatetime(v) {
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

async function getTableSchema(pool, tableName, schema) {
  var r = await query(pool,
    'SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS udtName ' +
    'FROM information_schema.COLUMNS ' +
    'WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? ' +
    'ORDER BY ORDINAL_POSITION',
    [schema || null, tableName]
  );
  return r.rows.map(function(row) {
    return { name: row.name, dataType: row.dataType, udtName: row.udtName };
  });
}

// Table/view/procedure listing — used by the db-list-* actions. MySQL has no
// separate schema concept from the database itself, so a null/omitted
// `schema` falls back to DATABASE() (the connection's own db), same as
// getTableSchema above.
async function listTables(pool, schema) {
  var r = await query(pool,
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES " +
    "WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_TYPE = 'BASE TABLE' " +
    "ORDER BY TABLE_NAME",
    [schema || null]
  );
  return r.rows.map(function(row) { return row.name; });
}

async function listViews(pool, schema) {
  var r = await query(pool,
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES " +
    "WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_TYPE = 'VIEW' " +
    "ORDER BY TABLE_NAME",
    [schema || null]
  );
  return r.rows.map(function(row) { return row.name; });
}

// ROUTINE_TYPE='PROCEDURE' only — excludes FUNCTION, same reasoning as the
// Postgres driver's listProcedures.
async function listProcedures(pool, schema) {
  var r = await query(pool,
    "SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES " +
    "WHERE ROUTINE_SCHEMA = COALESCE(?, DATABASE()) AND ROUTINE_TYPE = 'PROCEDURE' " +
    "ORDER BY ROUTINE_NAME",
    [schema || null]
  );
  return r.rows.map(function(row) { return row.name; });
}

// Idempotently ensure __xeplr_movement_id__ exists (introspect, then ALTER).
async function ensureMovementColumn(pool, tableName) {
  var exists = await query(pool,
    'SELECT 1 FROM information_schema.COLUMNS ' +
    'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [tableName, INTERNAL_MOVEMENT_COL]
  );
  if (exists.rows.length) return;
  await query(pool,
    'ALTER TABLE ' + quoteIdent(tableName) +
    ' ADD COLUMN ' + quoteIdent(INTERNAL_MOVEMENT_COL) + ' VARCHAR(255)'
  );
}

// LOB types that MySQL refuses to index without an explicit prefix length.
var LOB_TYPES = {
  tinytext: 1, text: 1, mediumtext: 1, longtext: 1,
  tinyblob: 1, blob: 1, mediumblob: 1, longblob: 1
};

// Idempotently ensure the UNIQUE index that backs ON DUPLICATE KEY UPDATE.
// Introspects the PK columns' actual types so it works even against a
// pre-existing table whose key column is TEXT/BLOB (indexes a 255-char prefix
// in that case — MySQL won't index a LOB column without one).
async function ensureUpsertIndex(pool, tableName, primaryKeys) {
  if (!primaryKeys || primaryKeys.length === 0) return;
  var idxName = upsertIndexName(tableName);
  var exists = await query(pool,
    'SELECT 1 FROM information_schema.STATISTICS ' +
    'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
    [tableName, idxName]
  );
  if (exists.rows.length) return;

  var schema = await getTableSchema(pool, tableName);
  var typeByName = {};
  schema.forEach(function(c) { typeByName[c.name] = String(c.dataType).toLowerCase(); });

  var cols = primaryKeys.map(function(pk) {
    return quoteIdent(pk) + (LOB_TYPES[typeByName[pk]] ? '(255)' : '');
  }).join(', ');

  await query(pool,
    'CREATE UNIQUE INDEX ' + quoteIdent(idxName) +
    ' ON ' + quoteIdent(tableName) + ' (' + cols + ')'
  );
}

// MySQL index names cap at 64 chars — truncate the table portion if needed.
function upsertIndexName(tableName) {
  var suffix = '_upsert_uniq';
  var room = 64 - suffix.length;
  var base = tableName.length > room ? tableName.slice(0, room) : tableName;
  return base + suffix;
}

// Stream a result set WITHOUT buffering it in memory — the read primitive
// db-fetch composes. mysql2 exposes a native row stream on the core connection;
// `for await` over it applies backpressure (highWaterMark bounds the rows
// buffered in the driver before it pauses reading from the socket).
//
//   opts: { sql, params?, batchSize? }  →  async iterable<row>
async function* fetchStream(pool, opts) {
  var batchSize = Math.max(1, parseInt(opts.batchSize || 1000, 10));
  var conn = await pool.getConnection();
  try {
    // .stream() lives on the core (non-promise) connection under .connection.
    var core = conn.connection;
    var q = (opts.params && opts.params.length)
      ? { sql: opts.sql, values: opts.params }
      : opts.sql;
    var stream = core.query(q).stream({ highWaterMark: batchSize });
    for await (var row of stream) yield row;
  } finally {
    conn.release();
  }
}

async function rollbackMovement(pool, tableName, movementId) {
  var errTable = tableName + '_import_errors';
  var result = { mainDeleted: 0, errorDeleted: 0 };

  var r1 = await query(pool,
    'DELETE FROM ' + quoteIdent(tableName) +
    ' WHERE ' + quoteIdent(INTERNAL_MOVEMENT_COL) + ' = ?',
    [movementId]
  );
  result.mainDeleted = r1.rowCount || 0;

  try {
    var r2 = await query(pool,
      'DELETE FROM ' + quoteIdent(errTable) + ' WHERE movement_id = ?',
      [movementId]
    );
    result.errorDeleted = r2.rowCount || 0;
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;   // table absent → ignore
  }

  return result;
}

module.exports = {
  requires: ['mysql2'],
  maxParams: MAX_PARAMS,

  // Connection lifecycle
  connect: connect,
  query:   query,
  close:   close,

  // SQL builders (pure functions, no DB access)
  toMysqlType:              toMysqlType,
  dataTypeToLogical:        dataTypeToLogical,
  quoteIdent:               quoteIdent,
  buildCreateTableSql:      buildCreateTableSql,
  buildCreateErrorTableSql: buildCreateErrorTableSql,
  buildAlterTableAddSql:    buildAlterTableAddSql,
  buildInsertSql:           buildInsertSql,

  // Idempotent DDL helpers (async — MySQL lacks single-statement guards)
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
