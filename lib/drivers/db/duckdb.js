// DuckDB driver — same interface as postgres/mysql/mssql, one difference that
// governs everything else: DuckDB is not a server. It is a FILE that a process
// maps into itself, so the rules about who may open it are this driver's
// problem rather than a DBA's.
//
// Peer dep: @duckdb/node-api (declared optional in package.json).
//
// ── THE ONE RULE ─────────────────────────────────────────────────────────
//
// Measured, not assumed (three processes against one file, DuckDB 1.5.5):
//
//   many processes read-only, nobody writing   → ALL OPEN
//   a second process read-write                → BLOCKED
//   a reader read-only WHILE a writer holds it → BLOCKED
//
// That third line is the one that bites, and it bites hardest under Node
// clustering: four app workers plus a scheduler is five processes, and one
// holding the file read-write locks out the other four completely. The failure
// is at OPEN, not at write — so a worker that never writes still dies.
//
// ── READ-ONLY BY DEFAULT. WRITING IS ASKED FOR, AT THE CALL SITE ─────────
//
// This used to be decided per PROCESS by an environment variable, and that was
// the wrong shape. It meant a deployment had to nominate one special process,
// the same code behaved differently depending on where it happened to run, and
// nothing at the point of a write said whether it was allowed to happen. A
// setting that far from the code it governs is a setting that gets out of step
// with it.
//
// So:  connect({ file })                  → READ-ONLY. Always. No exceptions.
//      connect({ file, access: 'rw' })    → a write, said out loud, in the code
//                                            doing the writing.
//
// Nothing needs to be configured to deploy this, no process is special, and
// "who can write" is answerable by grepping for `access: 'rw'`.
//
// ── HOLD THE LOCK BRIEFLY, AND QUEUE BEHIND IT ───────────────────────────
//
// The reason read-only can be the default is that a writer no longer keeps the
// file. It opens read-write, does its work, and closes — so the exclusive
// window is the length of one write rather than the lifetime of a process.
//
// Everything else WAITS instead of failing. `openTimeoutMs` retries on the
// lock error until it clears, which makes the file's own lock the mutex: two
// processes that both want to write do not need to know about each other, and
// a reader arriving mid-write blocks for the write rather than erroring. No
// designated writer, no coordination, no variable.
//
// The cost is honest and worth stating: while a big load holds the lock, reads
// of THAT FILE wait. It is bounded by making the loads incremental and by the
// split below.
//
// ── WHICH IS WHY CUBES ARE SEPARATE FILES ────────────────────────────────
//
// The replica takes a long write when it loads. A cube file is written once,
// closed, and never modified — so dashboards reading cubes are never behind a
// replica load at all. Only drill-down against the replica itself waits, and
// only while a load is running.
//
// Interface — identical to the other drivers, see postgres.js for the contract.

var INSTANCE_CACHE = {};   // absolute path → { instance, access, pool }

// Framework-managed column. Note there is NO __xeplr_id__ here, unlike the
// server dialects: it is a surrogate key nothing outside those drivers reads
// (grep says so), DuckDB has no SERIAL so it would cost a sequence, and on a
// 20M-row replica it is a whole extra column written for nobody's benefit.
var INTERNAL_ID_COL       = null;
var INTERNAL_MOVEMENT_COL = '__xeplr_movement_id__';

// Type mapping. Two departures from the Postgres driver, both deliberate:
//
//   number → DOUBLE, not NUMERIC. In DuckDB a bare NUMERIC means DECIMAL(18,3)
//   — a silent truncation to three decimal places and an overflow above ~10^15.
//   DOUBLE is what an analytical store is built to aggregate and what the cube
//   arithmetic assumes.
//
//   object/array → JSON, DuckDB's own type. There is no JSONB.
var TYPE_MAP = {
  string:   'VARCHAR',
  number:   'DOUBLE',
  boolean:  'BOOLEAN',
  date:     'DATE',
  datetime: 'TIMESTAMPTZ',
  object:   'JSON',
  array:    'JSON'
};

var DUCK_TO_LOGICAL = {
  'VARCHAR': 'string',  'CHAR': 'string',    'TEXT': 'string',   'BLOB': 'string',
  'UUID': 'string',     'BIT': 'string',     'ENUM': 'string',
  'BOOLEAN': 'boolean',
  'TINYINT': 'number',  'SMALLINT': 'number', 'INTEGER': 'number', 'BIGINT': 'number',
  'HUGEINT': 'number',  'UTINYINT': 'number', 'USMALLINT': 'number', 'UINTEGER': 'number',
  'UBIGINT': 'number',  'FLOAT': 'number',    'DOUBLE': 'number',  'DECIMAL': 'number',
  'DATE': 'date',
  'TIMESTAMP': 'datetime', 'TIMESTAMP WITH TIME ZONE': 'datetime',
  'TIMESTAMP_S': 'datetime', 'TIMESTAMP_MS': 'datetime', 'TIMESTAMP_NS': 'datetime',
  'TIME': 'datetime',   'TIME WITH TIME ZONE': 'datetime', 'INTERVAL': 'string',
  'JSON': 'object',     'STRUCT': 'object',   'MAP': 'object',
  'LIST': 'array'
};

// ── access mode ──────────────────────────────────────────────────────────

/**
 * What this CALL is asking to do — not what this process is.
 *
 * Read-only unless the caller says otherwise, in the call itself. There is no
 * environment variable and deliberately so: a process-wide setting means the
 * same code behaves differently depending on where it runs, nothing at the
 * point of a write says whether it is allowed, and a deployment has to
 * nominate a special process. `access: 'rw'` sitting in the code that writes
 * is the whole mechanism, and it is greppable.
 */
function accessMode(config) {
  var raw = String((config && config.access) || 'ro').toLowerCase();
  if (raw === 'ro' || raw === 'read_only' || raw === 'readonly') return 'ro';
  if (raw === 'rw' || raw === 'read_write' || raw === 'readwrite') return 'rw';
  throw new Error(
    'duckdb: access must be "rw" (this call writes) or "ro" (the default, reads only) — ' +
    'got "' + raw + '".'
  );
}

function isLockError(err) {
  var msg = String((err && err.message) || err);
  return msg.indexOf('Could not set lock') !== -1 || msg.indexOf('Conflicting lock') !== -1;
}

/**
 * Turn DuckDB's lock error into one that says what actually happened.
 *
 * Only reached after waiting — see openWithWait. The native message names a
 * PID and links to the concurrency docs, which is accurate and useless at 3am.
 */
function explainLockError(err, path, access, waitedMs) {
  if (!isLockError(err)) return err;

  var e = new Error(
    'duckdb: gave up waiting for "' + path + '" after ' + waitedMs + 'ms — another ' +
    'process is still holding it.\n' +
    '  This call asked for ' + (access === 'ro' ? 'READ-ONLY' : 'READ-WRITE') + ' access.\n' +
    '  One process may hold the file read-write, and no reader can open it while that ' +
    'lasts — so a long write blocks everything else on the same file.\n' +
    '  Either the write is taking longer than openTimeoutMs, or something opened it ' +
    'read-write and did not close it.\n' +
    '  Original: ' + String((err && err.message) || err)
  );
  e.cause = err;
  e.code = 'DUCKDB_LOCKED';
  return e;
}

/**
 * Open, waiting out whoever is holding the file rather than failing at them.
 *
 * This is what lets the file's own lock be the mutex. Two callers that both
 * want to write need no knowledge of each other: one gets it, the other waits
 * and then gets it. A reader arriving mid-write waits for the write instead of
 * erroring. Nothing has to be designated, configured or coordinated.
 *
 * Bounded, because waiting forever turns a stuck writer into a hung request
 * with nothing in the log. When the bound is hit the error says which of the
 * two things went wrong.
 */
async function openWithWait(api, key, options, access, timeoutMs) {
  var started = Date.now();
  var delay = 25;
  for (;;) {
    try {
      return await api.DuckDBInstance.create(key, options);
    } catch (err) {
      if (!isLockError(err)) throw err;
      var waited = Date.now() - started;
      if (waited >= timeoutMs) throw explainLockError(err, key, access, waited);
      await new Promise(function(r) { setTimeout(r, delay); });
      // Backing off rather than hammering: a load holds the file for minutes,
      // and a 25ms poll for that long is thousands of pointless syscalls.
      delay = Math.min(delay * 2, 1000);
    }
  }
}

// ── connection lifecycle ─────────────────────────────────────────────────

/**
 * A pool, in the shape the uploader expects — but DuckDB connections are not
 * sockets. They are handles onto ONE in-process instance, so the expensive
 * thing is the instance and it must be shared: two DuckDBInstance objects for
 * the same path in one process is the same conflicting-lock error as two
 * processes, self-inflicted.
 *
 *   config.file / config.database   path to the .duckdb file
 *   config.access                   'rw' to write. Omitted means READ-ONLY.
 *   config.openTimeoutMs            how long to wait out another holder
 *                                   (default 60s — a load can be slow)
 *   config.maxConnections           default 4
 *   config.keepIndexes              true to allow indexes in this file. Off by
 *                                   default — see "a written file keeps no
 *                                   index" below.
 *
 * READ-ONLY UNLESS ASKED. A caller that forgets `access: 'rw'` gets an error
 * on its first write, in the code doing the writing — not a silent success on
 * a handle it was never entitled to.
 */
async function connect(config) {
  config = config || {};
  var api = require('@duckdb/node-api');
  var path = require('path');

  var file = config.file || config.database || config.path;
  if (!file) throw new Error('duckdb: no file given — set config.file to the .duckdb path.');
  // ':memory:' is legitimate (tests, a scratch cube) and is not a path.
  var key = file === ':memory:' ? ':memory:' : path.resolve(file);

  var access = accessMode(config);
  var existing = INSTANCE_CACHE[key];

  if (existing) {
    // Already open in this process. A read-only ASK against a read-write
    // instance is fine — same process, same instance, no second lock — so it
    // is served rather than refused. The reverse is not: handing out write
    // access on a handle opened read-only fails later, at the write, in
    // whatever code happened to be running.
    if (access === 'rw' && existing.access === 'ro') {
      throw new Error(
        'duckdb: "' + key + '" is already open READ-ONLY in this process, so this write ' +
        'cannot proceed. Close the read-only handle first, or open it with access: "rw" ' +
        'from the start — one file cannot be both at once inside one process.'
      );
    }
    existing.refs++;
    return existing.pool;
  }

  var options = access === 'ro' ? { access_mode: 'READ_ONLY' } : {};
  // Waits rather than failing — see openWithWait. This is what makes the
  // file's own lock the mutex and removes any need to designate a writer.
  var instance = await openWithWait(api, key, options, access,
    config.openTimeoutMs == null ? 60000 : config.openTimeoutMs);

  var entry = {
    instance: instance,
    access: access,
    key: key,
    refs: 1,
    free: [],
    waiters: [],
    open: 0,
    max: Math.max(1, parseInt(config.maxConnections || 4, 10))
  };
  entry.pool = { __duck: entry, access: access, file: key };
  // ':memory:' never outlives its process, so it has no WAL to replay and
  // nothing for the guard to protect.
  entry.keepIndexes = Boolean(config.keepIndexes) || key === ':memory:';
  if (access === 'rw' && key !== ':memory:') {
    try {
      await guardOnOpen(entry);
    } catch (err) {
      try { instance.closeSync(); } catch (_) {}
      throw err;
    }
  }
  INSTANCE_CACHE[key] = entry;
  return entry.pool;
}

// ── a written file keeps no index ────────────────────────────────────────
//
// DuckDB 1.5.4–1.5.6 (duckdb/duckdb#26106, open upstream): after a process
// dies with rows still only in the WAL, the next open replays them into the
// table, and the next checkpoint drops them from every ART index on it. The
// rows are still there; the index no longer knows them. The first DELETE that
// reaches one fails with "Failed to delete all rows from index" — FATAL, and
// the whole file is unusable until the process restarts. Unique or not, any
// index. With no index there is nothing to fall out of step.
//
// So on every read-write open of a file:
//   1. CHECKPOINT first — folds a replayed WAL into the file before anything
//      else touches it, the upstream workaround (proven here: kill, reopen,
//      CHECKPOINT, DELETE succeeds even with an index).
//   2. DROP every index in it — one left from before this rule, or one that
//      slipped in, cannot be the thing a later crash breaks.
// and CREATE INDEX is refused on the pool from then on (see query). Upserts do
// not need one: they are staged and matched in the move (mergeStaged).
//
// A reader cannot trip this: a read-only open replays nothing and deletes
// nothing, and a file a crash left damaged gets its index dropped the first
// time anything opens it to write.
async function guardOnOpen(entry) {
  var conn = await entry.instance.connect();
  try {
    await conn.run('CHECKPOINT');
    if (entry.keepIndexes) return;
    var reader = await conn.runAndReadAll(
      "SELECT schema_name, index_name, table_name FROM duckdb_indexes()"
    );
    var found = reader.getRowObjectsJS();
    for (var i = 0; i < found.length; i++) {
      await conn.run('DROP INDEX IF EXISTS ' + quoteIdent(found[i].schema_name) + '.' + quoteIdent(found[i].index_name));
    }
    if (found.length) {
      await conn.run('CHECKPOINT');
      console.warn('[duckdb] ' + entry.key + ': dropped ' + found.length + ' index(es) (' +
        found.map(function(f) { return f.table_name + '.' + f.index_name; }).join(', ') +
        ') — a written file keeps none; see duckdb/duckdb#26106');
    }
  } finally {
    try { conn.closeSync(); } catch (_) {}
  }
}

var CREATE_INDEX = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i;

function refuseIndex(entry, sql) {
  if (entry.keepIndexes || !CREATE_INDEX.test(String(sql || ''))) return;
  throw new Error(
    'duckdb: CREATE INDEX refused on "' + entry.key + '". A file that is written keeps no index: ' +
    'DuckDB loses rows from an index after a crash (duckdb/duckdb#26106), and the next DELETE ' +
    'then fails fatally. Upserts are staged and need none. Open with keepIndexes: true only for ' +
    'a file that is never written after the index exists.'
  );
}

/** Check out a connection, creating one lazily up to `max`, else queueing. */
async function acquire(entry) {
  if (entry.free.length) return entry.free.pop();
  if (entry.open < entry.max) {
    entry.open++;
    try {
      return await entry.instance.connect();
    } catch (err) {
      entry.open--;
      throw err;
    }
  }
  return new Promise(function(resolve) { entry.waiters.push(resolve); });
}

function release(entry, conn) {
  var waiter = entry.waiters.shift();
  if (waiter) waiter(conn);
  else entry.free.push(conn);
}

function entryOf(pool) {
  var entry = pool && pool.__duck;
  if (!entry) throw new Error('duckdb: not a duckdb pool — was connect() called with this config?');
  return entry;
}

/**
 * Reference-counted, because one process legitimately opens the same warehouse
 * from several places at once (a build, a dashboard query, a listing) and the
 * first one to finish must not close the file out from under the others.
 */
async function close(pool) {
  if (!pool || !pool.__duck) return;
  var entry = pool.__duck;
  if (--entry.refs > 0) return;

  entry.free.forEach(function(c) { try { c.closeSync(); } catch (_) {} });
  entry.free = [];
  try { entry.instance.closeSync(); } catch (_) {}
  delete INSTANCE_CACHE[entry.key];
}

// ── query ────────────────────────────────────────────────────────────────

// BigInt is what DuckDB hands back for BIGINT/HUGEINT, and it poisons anything
// downstream that does arithmetic or JSON.stringify on a result. Narrowed to a
// number where that is lossless, and to TEXT where it is not: silently losing
// digits on a genuinely huge value would be wrong, and a BigInt left in a row
// crashes the first JSON.stringify that meets it. Text is also what Postgres,
// MySQL and SQL Server already return for such a value, so every source
// behaves alike.
function unBig(v) {
  if (typeof v !== 'bigint') return v;
  return (v <= 9007199254740991n && v >= -9007199254740991n) ? Number(v) : v.toString();
}

// The same, all the way down: a BigInt can sit INSIDE a value the normal read
// returns (an INTERVAL's micros, a list of BIGINTs). Arrays and plain objects
// keep their shape; a Date, a string or a number is left as it is.
function plainDeep(v) {
  if (typeof v === 'bigint') return unBig(v);
  if (v === null || typeof v !== 'object' || v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(plainDeep);
  if (Object.getPrototypeOf(v) !== Object.prototype) return v;
  var out = {};
  for (var k in v) out[k] = plainDeep(v[k]);
  return out;
}

/**
 * Run one statement. Returns the shape the other drivers return — `rows` as
 * objects, `rowCount`, and `columns` describing the OUTPUT regardless of
 * whether any row matched.
 *
 * ── rowCount, and why it is not `rows.length` ────────────────────────────
 *
 * DuckDB answers an INSERT or DELETE with a one-row result holding the number
 * of rows changed. So a DELETE that removed two thousand rows comes back with
 * rows.length === 1, and anything reading that as the row count reports 1 —
 * quietly, with no error anywhere. rollbackMovement is exactly such a caller,
 * and "rolled back 1 row" when it rolled back two thousand is the kind of
 * wrong number that gets believed.
 *
 * The result's OWN return type is what distinguishes the two cases, so that is
 * what this reads. CHANGED_ROWS is DML; QUERY_RESULT is a select.
 */
async function query(pool, sql, params) {
  var entry = entryOf(pool);
  refuseIndex(entry, sql);
  var conn = await acquire(entry);
  try {
    var api = require('@duckdb/node-api');
    var reader = await conn.runAndReadAll(sql, params && params.length ? params : undefined);

    if (reader.returnType === api.ResultReturnType.CHANGED_ROWS) {
      return { rows: [], rowCount: unBig(reader.rowsChanged) || 0, columns: [] };
    }

    var columns = reader.columnNames();
    var rows = reader.getRowObjectsJS().map(function(row) {
      var out = {};
      for (var k in row) out[k] = plainDeep(row[k]);
      return out;
    });
    return { rows: rows, rowCount: rows.length, columns: columns };
  } catch (err) {
    throw explainLockError(err, entry.key, entry.access, 0);
  } finally {
    release(entry, conn);
  }
}

// ── SQL builders ─────────────────────────────────────────────────────────

function toPgType(type) { return TYPE_MAP[type] || 'VARCHAR'; }

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// See INTERNAL_ID_COL above for why there is no surrogate key column here.
function buildCreateTableSql(tableName, columns, _primaryKeys) {
  var defs = [quoteIdent(INTERNAL_MOVEMENT_COL) + ' VARCHAR NOT NULL'];
  for (var i = 0; i < columns.length; i++) {
    defs.push(quoteIdent(columns[i].name) + ' ' + toPgType(columns[i].type));
  }
  return 'CREATE TABLE IF NOT EXISTS ' + quoteIdent(tableName) +
         ' (\n  ' + defs.join(',\n  ') + '\n)';
}

function buildCreateErrorTableSql(tableName) {
  var errTable = tableName + '_import_errors';
  return 'CREATE TABLE IF NOT EXISTS ' + quoteIdent(errTable) + ' (\n' +
    '  movement_id VARCHAR NOT NULL,\n' +
    '  row_num INTEGER,\n' +
    '  error_description VARCHAR,\n' +
    '  underlying_sql VARCHAR,\n' +
    '  raw_row JSON,\n' +
    '  recorded_at TIMESTAMPTZ DEFAULT now()\n' +
    ')';
}

// The UNIQUE index is not optional decoration on DuckDB — ON CONFLICT has no
// conflict target without it, so an upsert silently becomes an error.
function buildUpsertIndexSql(tableName, primaryKeys) {
  if (!primaryKeys || primaryKeys.length === 0) return null;
  return 'CREATE UNIQUE INDEX IF NOT EXISTS ' + quoteIdent(tableName + '_upsert_uniq') +
         ' ON ' + quoteIdent(tableName) + ' (' + primaryKeys.map(quoteIdent).join(', ') + ')';
}

function buildAlterTableAddSql(tableName, columns) {
  return columns.map(function(c) {
    return 'ALTER TABLE ' + quoteIdent(tableName) +
           ' ADD COLUMN IF NOT EXISTS ' + quoteIdent(c.name) + ' ' + toPgType(c.type);
  });
}

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
    var updateCols = colNames.filter(function(c) { return primaryKeys.indexOf(c) === -1; });
    var setClause = updateCols.concat([INTERNAL_MOVEMENT_COL]).map(function(c) {
      return quoteIdent(c) + ' = EXCLUDED.' + quoteIdent(c);
    }).join(', ');
    sql += ' ON CONFLICT (' + primaryKeys.map(quoteIdent).join(', ') +
           ') DO UPDATE SET ' + setClause;
  }

  return { sql: sql, params: params };
}

// A calendar date as YYYY-MM-DD with no timezone conversion — see the note in
// postgres.js; the bug it avoids is identical here.
function toDateOnly(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.getFullYear() + '-' +
      String(v.getMonth() + 1).padStart(2, '0') + '-' +
      String(v.getDate()).padStart(2, '0');
  }
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : v;
}

// Coerce a JS value to the effective column type. Same contract as the other
// drivers: a value that cannot fit passes through unchanged so DuckDB rejects
// it and SqlQueue's bisection isolates the row, rather than throwing here and
// failing the whole batch.
//
// Everything leaves as a string, number, boolean or null — never a Date and
// never a BigInt — because those are the values the bindings map cleanly.
function coerceValue(v, type) {
  if (v === undefined || v === null) return null;

  switch (type) {
    case 'string':
      if (v instanceof Date)     return v.toISOString();
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);

    case 'number':
      if (typeof v === 'number') return v;
      if (typeof v === 'bigint') return unBig(v);
      if (typeof v === 'string') {
        var n = Number(v);
        return isNaN(n) ? v : n;
      }
      return v;

    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        var lower = v.toLowerCase().trim();
        if (lower === 'true'  || lower === '1' || lower === 'yes' || lower === 'y') return true;
        if (lower === 'false' || lower === '0' || lower === 'no'  || lower === 'n') return false;
      }
      if (typeof v === 'number') return v !== 0;
      return v;

    case 'date':
      return toDateOnly(v);

    case 'datetime':
      if (v instanceof Date) return v.toISOString();
      return v;

    case 'object':
    case 'array':
      if (typeof v === 'string') return v;
      return JSON.stringify(v);

    default:
      return v;
  }
}

// DuckDB reports parameterised types as "DECIMAL(18,3)" / "STRUCT(...)", so the
// lookup is on the head of the string rather than the whole of it.
function dataTypeToLogical(dataType) {
  if (!dataType) return 'string';
  var head = String(dataType).toUpperCase().split('(')[0].trim();
  return DUCK_TO_LOGICAL[head] || DUCK_TO_LOGICAL[String(dataType).toUpperCase()] || 'string';
}

// ── idempotent DDL ───────────────────────────────────────────────────────

async function ensureMovementColumn(pool, tableName) {
  await query(pool, 'ALTER TABLE ' + quoteIdent(tableName) +
    ' ADD COLUMN IF NOT EXISTS ' + quoteIdent(INTERNAL_MOVEMENT_COL) + ' VARCHAR');
}

async function ensureUpsertIndex(pool, tableName, primaryKeys) {
  var sql = buildUpsertIndexSql(tableName, primaryKeys);
  if (sql) await query(pool, sql);   // refused on a guarded file — the uploader stages DuckDB upserts instead
}

// ── introspection ────────────────────────────────────────────────────────

// 'main' rather than 'public' — that is DuckDB's default schema, and passing
// 'public' here returns an empty column list for a table that plainly exists.
async function getTableSchema(pool, tableName, schema) {
  var r = await query(pool,
    'SELECT column_name, data_type FROM information_schema.columns ' +
    'WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
    [schema || 'main', tableName]);
  return r.rows.map(function(row) {
    return { name: row.column_name, dataType: row.data_type, udtName: row.data_type };
  });
}

async function listTables(pool, schema) {
  var r = await query(pool,
    "SELECT table_name FROM information_schema.tables " +
    "WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
    [schema || 'main']);
  return r.rows.map(function(row) { return row.table_name; });
}

async function listViews(pool, schema) {
  var r = await query(pool,
    'SELECT table_name FROM information_schema.views WHERE table_schema = $1 ORDER BY table_name',
    [schema || 'main']);
  return r.rows.map(function(row) { return row.table_name; });
}

// DuckDB has no stored procedures. Empty rather than an error, so a UI that
// offers "a stored procedure" against every connection gets an empty list and
// says so, instead of a failed request.
async function listProcedures(_pool, _schema) {
  return [];
}

// ── plain values out of a stream ─────────────────────────────────────────
//
// A streamed chunk (getRowObjects) hands DECIMAL, TIMESTAMP, INTERVAL, UUID
// and the nested types back as DuckDB WRAPPER objects, several with a BigInt
// inside. They are not the values the rest of the code expects, and the first
// JSON.stringify that meets one fails ("Do not know how to serialize a
// BigInt") — which is how a report grouped by an amount or a timestamp from a
// cube used to die.
//
// Converting each wrapper in JavaScript doubles the cost of a streamed read.
// So DuckDB converts them inside its own engine instead, by wrapping the
// query: measured on 1M rows, +2% (+6% with the timestamp turned into a Date
// here), against +100% for the JS converter.
//
//   passes through   booleans, integers (BigInt narrowed by unBig), floats,
//                    text, enums
//   DECIMAL          DOUBLE: what the non-streamed read (getRowObjectsJS)
//                    returns too
//   DATE, TIMESTAMP* epoch milliseconds, turned into a Date as the row is
//                    built — the same type Postgres and the normal read give.
//                    A timestamp WITHOUT a zone is read as UTC (data is kept
//                    in UTC; the viewer's zone is applied when rendering). One
//                    WITH a zone keeps its exact instant: epoch_ms is taken on
//                    it directly, never after a cast that would apply the
//                    session's zone.
//   LIST, STRUCT,    JSON, parsed back here: arrays and objects, the shape the
//   MAP, ARRAY       normal read gives
//   anything else    VARCHAR (TIME, INTERVAL, UUID, …). A type nobody has met
//                    yet becomes text rather than a crash.
//
// When no column needs converting, the query runs exactly as given.
var PASS_THROUGH_TYPES = null;
var DATE_TYPES = null;
var NESTED_TYPES = null;
function typeSets() {
  if (PASS_THROUGH_TYPES) return;
  var T = require('@duckdb/node-api').DuckDBTypeId;
  PASS_THROUGH_TYPES = new Set([T.BOOLEAN, T.TINYINT, T.SMALLINT, T.INTEGER, T.BIGINT, T.HUGEINT,
    T.UTINYINT, T.USMALLINT, T.UINTEGER, T.UBIGINT, T.UHUGEINT, T.FLOAT, T.DOUBLE,
    T.VARCHAR, T.ENUM, T.SQLNULL].filter(function(x) { return x !== undefined; }));
  DATE_TYPES = {};
  DATE_TYPES[T.DATE] = 'plain';
  DATE_TYPES[T.TIMESTAMP] = 'plain';
  DATE_TYPES[T.TIMESTAMP_S] = 'plain';
  DATE_TYPES[T.TIMESTAMP_MS] = 'plain';
  DATE_TYPES[T.TIMESTAMP_NS] = 'plain';
  DATE_TYPES[T.TIMESTAMP_TZ] = 'zoned';
  NESTED_TYPES = new Set([T.LIST, T.STRUCT, T.MAP, T.ARRAY, T.UNION].filter(function(x) { return x !== undefined; }));
}

function stripTrailingSemicolon(sql) {
  return String(sql).replace(/[\s;]+$/, '');
}

async function plainValuesPlan(conn, sql) {
  typeSets();
  var prepared = await conn.prepare(sql);
  var count = prepared.columnCount;
  var select = [];
  var inner = [];
  var dateColumns = [];
  var jsonColumns = [];
  var changed = false;
  for (var i = 0; i < count; i++) {
    var name = prepared.columnName(i);
    var typeId = prepared.columnTypeId(i);
    var col = '"__c' + i + '"';
    inner.push(col);
    var expr;
    if (PASS_THROUGH_TYPES.has(typeId)) {
      expr = col;
    } else if (DATE_TYPES[typeId] === 'zoned') {
      expr = 'epoch_ms(' + col + ')';
      dateColumns.push(name);
      changed = true;
    } else if (DATE_TYPES[typeId] === 'plain') {
      expr = 'epoch_ms(CAST(' + col + ' AS TIMESTAMP))';
      dateColumns.push(name);
      changed = true;
    } else if (typeId === require('@duckdb/node-api').DuckDBTypeId.DECIMAL) {
      expr = 'CAST(' + col + ' AS DOUBLE)';
      changed = true;
    } else if (NESTED_TYPES.has(typeId)) {
      expr = 'CAST(to_json(' + col + ') AS VARCHAR)';
      jsonColumns.push(name);
      changed = true;
    } else {
      expr = 'CAST(' + col + ' AS VARCHAR)';
      changed = true;
    }
    select.push(expr + ' AS ' + quoteIdent(name));
  }
  if (!changed) return { sql: sql, dateColumns: [], jsonColumns: [] };
  // Positional renames (__c0, __c1, …) so two source columns with one name
  // stay two columns, whatever they are called.
  return {
    sql: 'SELECT ' + select.join(', ') + ' FROM (' + stripTrailingSemicolon(sql) + '\n) AS "__plain"(' + inner.join(', ') + ')',
    dateColumns: dateColumns,
    jsonColumns: jsonColumns
  };
}

// ── streaming read ───────────────────────────────────────────────────────

/**
 * Stream a result set without buffering it — chunk at a time, so a 20M-row
 * read costs one chunk of memory rather than twenty million rows of it.
 *
 * `fetchChunk()` is the backpressure: the next chunk is only pulled when the
 * consumer asks for the next row. `readAll()` on a reader would defeat this
 * entirely by materialising the lot first.
 */
async function* fetchStream(pool, opts) {
  var entry = entryOf(pool);
  var conn = await acquire(entry);
  try {
    var plan = await plainValuesPlan(conn, opts.sql);
    var result = await conn.stream(plan.sql, (opts.params && opts.params.length) ? opts.params : undefined);
    var names = result.columnNames();
    var dates = plan.dateColumns;
    var jsons = plan.jsonColumns;
    while (true) {
      var chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      var rows = chunk.getRowObjects(names);
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var out = {};
        for (var k in row) out[k] = unBig(row[k]);
        for (var d = 0; d < dates.length; d++) {
          var v = out[dates[d]];
          if (v !== null && v !== undefined) out[dates[d]] = new Date(v);
        }
        for (var j = 0; j < jsons.length; j++) {
          var jv = out[jsons[j]];
          if (typeof jv === 'string') out[jsons[j]] = JSON.parse(jv);
        }
        yield out;
      }
    }
  } catch (err) {
    throw explainLockError(err, entry.key, entry.access, 0);
  } finally {
    release(entry, conn);
  }
}

// ── rollback ─────────────────────────────────────────────────────────────

async function rollbackMovement(pool, tableName, movementId) {
  var result = { mainDeleted: 0, errorDeleted: 0 };

  var r1 = await query(pool,
    'DELETE FROM ' + quoteIdent(tableName) +
    ' WHERE ' + quoteIdent(INTERNAL_MOVEMENT_COL) + ' = $1', [movementId]);
  result.mainDeleted = r1.rowCount || 0;

  try {
    var r2 = await query(pool,
      'DELETE FROM ' + quoteIdent(tableName + '_import_errors') + ' WHERE movement_id = $1',
      [movementId]);
    result.errorDeleted = r2.rowCount || 0;
  } catch (err) {
    // The error table only exists once a movement has actually errored, so
    // "it isn't there" is the normal case, not a failure.
    if (!/does not exist|not found|Table with name/i.test(String(err.message))) throw err;
  }

  return result;
}

// ── staged loads ─────────────────────────────────────────────────────────
//
// A STAGED load never writes into its target while it runs. Its batches land
// in `<target>__xeplr_staging`; when every batch is in, ONE transaction moves
// them into the target and records the load in `__xeplr_loads`. So a load
// that stops, fails or is killed midway has touched only the staging table:
// undoing it costs what IT wrote, never what the target already held, and no
// rollback of the target is ever needed.
//
// DuckDB commits a transaction whole or not at all, so a crash during the
// move leaves the target as it was. The ledger row is written in that same
// transaction: if it is there the load landed, if it is not nothing did —
// answered without scanning the target (see committedMovement).
//
// NO UNIQUE INDEX. A staged upsert matches keys in the move itself, so the
// upsert index is dropped rather than created. It was the index a copy killed
// mid-write left out of step with its rows, and a DELETE through such an index
// fails with "Failed to delete all rows from index" — fatally, invalidating
// the whole database.

var STAGING_SUFFIX = '__xeplr_staging';
var LOADS_LEDGER   = '__xeplr_loads';

function stagingTableFor(tableName) { return tableName + STAGING_SUFFIX; }

/** Run fn on ONE connection — a transaction's statements must not be spread across the pool. */
async function withConnection(pool, fn) {
  var entry = entryOf(pool);
  var conn = await acquire(entry);
  try {
    return await fn(conn);
  } finally {
    release(entry, conn);
  }
}

/**
 * A fresh, empty staging table shaped exactly like the target (which must
 * exist). A staging table already there is a load that died before its move,
 * and is dropped: nothing in it ever reached the target.
 */
async function prepareStaging(pool, tableName) {
  var staging = stagingTableFor(tableName);
  await query(pool, 'DROP INDEX IF EXISTS ' + quoteIdent(tableName + '_upsert_uniq'));
  await query(pool, 'DROP TABLE IF EXISTS ' + quoteIdent(staging));
  await query(pool, 'CREATE TABLE ' + quoteIdent(staging) + ' AS SELECT * FROM ' + quoteIdent(tableName) + ' LIMIT 0');
  return staging;
}

async function dropStaging(pool, tableName) {
  await query(pool, 'DROP TABLE IF EXISTS ' + quoteIdent(stagingTableFor(tableName)));
}

/**
 * Move a load's staged rows into its target, in one transaction with its
 * ledger row, then drop the staging table.
 *
 * With primaryKeys it is an upsert: target rows whose key is staged are
 * replaced. Within one load the last row staged for a key wins, as it did
 * under ON CONFLICT DO UPDATE; a row with a NULL key matches nothing, and is
 * kept, as ON CONFLICT kept it.
 *
 * With replaceFrom { column } it replaces a RANGE: target rows with column >=
 * the earliest staged value are deleted first ("re-load the last N days" —
 * the caller reads the source from its cutoff; the boundary here is what that
 * read actually brought). `replaced` is then the rows deleted.
 *
 * Returns { inserted, replaced }.
 */
async function mergeStaged(pool, opts) {
  var target = quoteIdent(opts.targetTable);
  var staging = quoteIdent(stagingTableFor(opts.targetTable));
  var ledger = quoteIdent(LOADS_LEDGER);
  var pks = (opts.primaryKeys && opts.primaryKeys.length) ? opts.primaryKeys : null;
  var cols = [INTERNAL_MOVEMENT_COL].concat(opts.columns.map(function(c) { return c.name; }))
    .map(quoteIdent).join(', ');

  var source = staging;
  if (pks) {
    var keys = pks.map(quoteIdent);
    source = '(SELECT ' + cols + ' FROM ' + staging +
      ' QUALIFY row_number() OVER (PARTITION BY ' + keys.join(', ') + ' ORDER BY rowid DESC) = 1' +
      ' OR ' + keys.map(function(k) { return k + ' IS NULL'; }).join(' OR ') + ')';
  }

  var counts = await withConnection(pool, async function(conn) {
    await conn.run('CREATE TABLE IF NOT EXISTS ' + ledger +
      ' (movement_id VARCHAR, target_table VARCHAR, inserted BIGINT, replaced BIGINT, committed_at TIMESTAMPTZ)');
    await conn.run('BEGIN TRANSACTION');
    try {
      var replaced = 0;
      // A RANGE REPLACED: the target's rows from the EARLIEST STAGED value
      // on go, and the staged rows take their place — inside this one
      // transaction, so a crash leaves the old rows, never neither.
      //
      // From what was staged, not from a date passed in. The staged values
      // came through the same reads and conversions as the target's own, so
      // this boundary is exact; a cutoff computed elsewhere is a time zone
      // away from it (a DATE read as UTC midnight here, compared at the
      // source's local midnight there) — and a day deleted but never read
      // back is a day lost. Nothing staged: MIN is NULL, nothing is deleted.
      if (opts.replaceFrom) {
        var col = quoteIdent(opts.replaceFrom.column);
        var cut = await conn.run('DELETE FROM ' + target + ' WHERE ' + col + ' >= (SELECT MIN(' + col + ') FROM ' + staging + ')');
        replaced = Number(cut.rowsChanged) || 0;
      }
      if (pks) {
        var del = await conn.run('DELETE FROM ' + target + ' AS t USING ' + staging + ' AS s WHERE ' +
          pks.map(function(k) { return 't.' + quoteIdent(k) + ' = s.' + quoteIdent(k); }).join(' AND '));
        replaced = Number(del.rowsChanged) || 0;
      }
      var ins = await conn.run('INSERT INTO ' + target + ' (' + cols + ') SELECT ' + cols + ' FROM ' + source);
      var inserted = Number(ins.rowsChanged) || 0;
      await conn.run('INSERT INTO ' + ledger + ' VALUES ($1, $2, $3, $4, now())',
        [opts.movementId, opts.targetTable, inserted, replaced]);
      await conn.run('COMMIT');
      return { inserted: inserted, replaced: replaced };
    } catch (err) {
      await conn.run('ROLLBACK').catch(function() {});
      throw err;
    }
  });

  // After the commit, and allowed to fail: the load has landed, and the next
  // load drops a leftover staging table anyway.
  await dropStaging(pool, opts.targetTable).catch(function() {});
  return counts;
}

/**
 * Did this movement's staged load reach its target? The ledger row, or null.
 * The answer a run that ended without saying (a killed process) needs.
 */
async function committedMovement(pool, movementId) {
  var r;
  try {
    r = await query(pool, 'SELECT movement_id, target_table, inserted, replaced, committed_at FROM ' +
      quoteIdent(LOADS_LEDGER) + ' WHERE movement_id = $1 LIMIT 1', [movementId]);
  } catch (err) {
    if (/does not exist/i.test(String(err.message))) return null;
    throw err;
  }
  return r.rows[0] || null;
}

module.exports = {
  requires: ['@duckdb/node-api'],

  connect: connect,
  query:   query,
  close:   close,

  toPgType:                 toPgType,
  dataTypeToLogical:        dataTypeToLogical,
  quoteIdent:               quoteIdent,
  buildCreateTableSql:      buildCreateTableSql,
  buildCreateErrorTableSql: buildCreateErrorTableSql,
  buildUpsertIndexSql:      buildUpsertIndexSql,
  buildAlterTableAddSql:    buildAlterTableAddSql,
  buildInsertSql:           buildInsertSql,

  ensureMovementColumn: ensureMovementColumn,
  ensureUpsertIndex:    ensureUpsertIndex,
  // An upsert into DuckDB is always staged: it matches keys in the move, so it
  // needs no index, which a written DuckDB file must not keep.
  stagesUpserts:        true,

  getTableSchema:  getTableSchema,
  listTables:      listTables,
  listViews:       listViews,
  listProcedures:  listProcedures,

  fetchStream: fetchStream,

  rollbackMovement: rollbackMovement,

  stagingTableFor:   stagingTableFor,
  prepareStaging:    prepareStaging,
  dropStaging:       dropStaging,
  mergeStaged:       mergeStaged,
  committedMovement: committedMovement,
  LOADS_LEDGER:      LOADS_LEDGER,

  INTERNAL_ID_COL:       INTERNAL_ID_COL,
  INTERNAL_MOVEMENT_COL: INTERNAL_MOVEMENT_COL,

  // Exposed for the warehouse layer and for tests — "is this process the
  // writer" is a question worth being able to ask without opening a file.
  accessMode: accessMode
};
